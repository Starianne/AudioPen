
import { Soundfont } from 'https://unpkg.com/smplr@0.16.4/dist/index.mjs';

const fileInput = document.getElementById('fileInput');
const positionSlider = document.getElementById('positionSlider');
const generateBtn = document.getElementById('generateMusicBtn2');
const stopBtn = document.getElementById('stopMusicBtn2');
const info = document.getElementById('info');

let audioContext;
let loadedFile = null;
const instruments = {};  // smplr instruments, keyed by name (loaded on first use)

// MUSICAL SETTINGS
const SCALE = [0, 2, 4, 7, 9]; // C major pentatonic

// INSTRUMENTS: one per voice of the chord, ordered LOW to HIGH register.
// Any smplr Soundfont name works, e.g. 'viola', 'oboe', 'string_ensemble_1'.
const INSTRUMENTS = [
    { name: 'cello' },     // lowest notes
    { name: 'clarinet' },
    { name: 'violin' },
    { name: 'flute' }      // highest notes
];

// DATA -> GRID SETTINGS
// Each COLUMN is one price bar (one moment in time). Each ROW is one pitch:
// the window's lowest price is the bottom row, its highest price the top row.
const ROWS = 20;                // pitch resolution (20 pentatonic notes, ~4 octaves)
const NUM_BARS = 128;           // how many price bars to read
const CHUNK_BYTES = 64 * 1024;  // only read a small slice of a huge file
const COLUMN_DURATION = 0.15;   // seconds per column
const MIN_NOTE_DURATION = 0.4;  // shortest a note can ring (single-column notes)
const REST_GAP_SECONDS = 30;    // a gap this long in the data adds a silent column

// HOW STRONGLY EACH PART OF A BAR "SOUNDS" (like edge strength in the image version)
const CLOSE_STRENGTH = 1.0;     // the row the bar closed in
const OPEN_STRENGTH = 0.8;      // the row the bar opened in
const EXTREME_STRENGTH = 0.55;  // the rows of the bar's high and low
const BODY_STRENGTH = 0.45;     // rows between the low and high
const MIN_ACTIVITY = 0.5;       // quietest a bar gets (bars with few ticks are softer)

// NOTE SELECTION (same logic as the image version)
const MAX_NOTES_PER_COLUMN = INSTRUMENTS.length; // one note per instrument; strongest win
const THRESHOLD = 0.3;          // strength needed to START a note
const CONTINUE_CUTOFF = 0.6;    // a held note survives down to 60% of that
const CONTINUE_BONUS = 1.5;     // held notes are preferred over new ones when ranking

// Convert a scale degree into a MIDI note
function getScaleNote(degree) {
    const octave = Math.floor(degree / SCALE.length);
    const note = SCALE[degree % SCALE.length];

    return 48 + octave * 12 + note;
}

// ---------------------------------------------------------------
// DATA
// ---------------------------------------------------------------

// Read a small window of the file at a chosen position (0 to 1).
// Slicing means a multi-hundred-MB file never has to be loaded whole.
async function readWindow(file, fraction) {
    const maxStart = Math.max(0, file.size - CHUNK_BYTES);
    const start = Math.floor(maxStart * fraction);
    const text = await file.slice(start, start + CHUNK_BYTES).text();

    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();                          // partial first line
    if (start + CHUNK_BYTES < file.size) lines.pop();      // partial last line

    const rows = [];

    for (const line of lines) {
        const parts = line.trim().split(/[\t, ]+/).map(Number);

        if (parts.length < 6 || parts.some(Number.isNaN)) continue; // header/blank

        rows.push({
            t: parts[0],
            open: parts[1],
            close: parts[2],
            high: parts[3],
            low: parts[4],
            vol: parts[5]
        });
    }

    return rows.slice(0, NUM_BARS);
}

// Turn price bars into columns of per-row strengths, like the max-pooled
// edge grid in the image version. A column of all zeros is a rest.
function buildColumns(bars) {
    const minPrice = Math.min(...bars.map(b => b.low));
    const maxPrice = Math.max(...bars.map(b => b.high));
    const span = (maxPrice - minPrice) || 1;
    const maxVol = Math.max(...bars.map(b => b.vol)) || 1;

    const rowOf = price =>
        Math.min(ROWS - 1, Math.max(0, Math.floor((price - minPrice) / span * ROWS)));

    const columns = [];
    const shapes = [];   // per column: the bar's rows for drawing (null = rest)

    bars.forEach((bar, i) => {

        // Long quiet gap in the market -> a silent column that ends held notes
        if (i > 0 && bar.t - bars[i - 1].t >= REST_GAP_SECONDS) {
            columns.push(new Float32Array(ROWS));
            shapes.push(null);
        }

        const strength = new Float32Array(ROWS);

        const low = rowOf(bar.low);
        const high = rowOf(bar.high);

        for (let r = low; r <= high; r++) strength[r] = BODY_STRENGTH;

        strength[low] = Math.max(strength[low], EXTREME_STRENGTH);
        strength[high] = Math.max(strength[high], EXTREME_STRENGTH);

        const openRow = rowOf(bar.open);
        const closeRow = rowOf(bar.close);

        strength[openRow] = Math.max(strength[openRow], OPEN_STRENGTH);
        strength[closeRow] = Math.max(strength[closeRow], CLOSE_STRENGTH);

        // More ticks in the bar = louder
        const activity = MIN_ACTIVITY + (1 - MIN_ACTIVITY) * Math.min(1, bar.vol / maxVol);

        for (let r = 0; r < ROWS; r++) strength[r] *= activity;

        columns.push(strength);
        shapes.push({ low, high, open: openRow, close: closeRow });
    });

    return { columns, shapes, minPrice, maxPrice };
}

// ---------------------------------------------------------------
// MUSIC
// ---------------------------------------------------------------

// Build the list of held notes from the columns.
function buildNotes(columns) {
    const notes = [];
    let active = [];   // notes still being held from the previous column

    columns.forEach((strength, column) => {

        // Collect every row in this column that is strong enough
        const candidates = [];

        for (let row = 0; row < ROWS; row++) {

            // Is this the continuation of a note already sounding (same row)?
            const holding = active.find(n => n.row === row);

            // Held notes get a lower cutoff and a ranking bonus, so one weak
            // bar in a long run does not chop the note into pieces.
            const needed = holding ? THRESHOLD * CONTINUE_CUTOFF : THRESHOLD;

            if (strength[row] >= needed) {
                candidates.push({
                    row,
                    holding,
                    rank: strength[row] * (holding ? CONTINUE_BONUS : 1)
                });
            }
        }

        // Keep only the strongest few (one per instrument)
        candidates.sort((a, b) => b.rank - a.rank);
        const chosen = candidates.slice(0, MAX_NOTES_PER_COLUMN);

        const used = new Set();      // instruments taken in THIS chord
        const nextActive = [];

        // 1) Notes that simply carry on keep their instrument
        for (const c of chosen) {
            if (!c.holding) continue;

            const note = c.holding;

            note.endColumn = column;
            note.peak = Math.max(note.peak, strength[c.row]);

            used.add(note.instrument);
            nextActive.push(note);
        }

        // 2) New notes pick an instrument that suits their register
        for (const c of chosen) {
            if (c.holding) continue;

            // Higher price = higher pitch
            const degree = c.row;

            let pick = Math.min(
                INSTRUMENTS.length - 1,
                Math.floor(degree * INSTRUMENTS.length / ROWS)
            );

            // If another note in this chord already took it, use the nearest free one
            if (used.has(pick)) {
                let best = -1;

                for (let k = 0; k < INSTRUMENTS.length; k++) {
                    if (used.has(k)) continue;

                    if (best === -1 || Math.abs(k - pick) < Math.abs(best - pick)) {
                        best = k;
                    }
                }

                pick = best;
            }

            used.add(pick);

            const note = {
                row: c.row,
                midi: getScaleNote(degree),
                instrument: pick,            // index into INSTRUMENTS
                startColumn: column,
                endColumn: column,
                peak: strength[c.row]
            };

            notes.push(note);
            nextActive.push(note);
        }

        active = nextActive;
    });

    // Final timing and loudness for each note
    for (const note of notes) {
        const length = note.endColumn - note.startColumn + 1;

        note.offset = note.startColumn * COLUMN_DURATION;
        note.duration = Math.max(length * COLUMN_DURATION, MIN_NOTE_DURATION);

        // Stronger = louder note (MIDI velocity 30-127)
        note.velocity = Math.round(30 + Math.min(1, note.peak / CLOSE_STRENGTH) * 97);
    }

    return notes;
}

fileInput.addEventListener('change', () => {
    loadedFile = fileInput.files[0] || null;
    generateBtn.disabled = !loadedFile;
    info.textContent = loadedFile ? `Loaded ${loadedFile.name}` : '';
});

// Generate music from the price data
generateBtn.addEventListener('click', async () => {
    if (!loadedFile) return;

    // Stop previous composition
    stopMusic();

    // Create audio context
    if (!audioContext) {
        audioContext = new AudioContext();
    }

    await audioContext.resume();

    const bars = await readWindow(loadedFile, positionSlider.value / 100);

    if (bars.length < 2) {
        info.textContent = 'Not enough valid rows at this position.';
        return;
    }

    // Load every instrument's samples (each is only loaded once)
    for (const { name } of INSTRUMENTS) {
        if (!instruments[name]) {
            instruments[name] = new Soundfont(audioContext, { instrument: name });
        }
    }

    await Promise.all(Object.values(instruments).map(i => i.load));

    const { columns, shapes, minPrice, maxPrice } = buildColumns(bars);
    const notes = buildNotes(columns);

    const startTime = audioContext.currentTime + 0.1;

    // Start the visual first, so it shows even if audio has a problem
    startRoll(notes, shapes, columns.length, startTime, minPrice, maxPrice);

    // Schedule each note once, held for the whole length of its run
    try {
        for (const note of notes) {
            instruments[INSTRUMENTS[note.instrument].name].start({
                note: note.midi,
                time: startTime + note.offset,
                duration: note.duration,
                velocity: note.velocity
            });
        }
    } catch (err) {
        console.error('Audio scheduling error:', err);
    }

    const from = new Date(bars[0].t * 1000).toISOString();
    const to = new Date(bars[bars.length - 1].t * 1000).toISOString();

    info.textContent =
        `${bars.length} bars, ${notes.length} notes, ${(columns.length * COLUMN_DURATION).toFixed(1)} s\n` +
        `${from} to ${to}\n` +
        `Price range ${minPrice.toFixed(4)} to ${maxPrice.toFixed(4)}`;
});

// Stop playback
function stopMusic() {
    Object.values(instruments).forEach(i => i.stop());

    cancelAnimationFrame(animationId);
    clearRoll();
}

stopBtn.addEventListener('click', stopMusic);

// ---------------------------------------------------------------
// VISUAL (a piano roll that lights up in sync with the audio)
// ---------------------------------------------------------------
// The canvas is created automatically just below the #info element.
//   x axis = time (one column per price bar)
//   y axis = price (the same rows that set the pitch)
//   white candles = the price data itself (wick = high/low, body = open/close)
//   coloured bars = the notes, coloured by the instrument playing them

const COLOURS = [
    '255, 112, 67',   // cello
    '255, 202, 40',   // clarinet
    '102, 187, 106',  // violin
    '66, 165, 245'    // flute
];

const FLASH_TIME = 0.3;     // seconds a note's highlight takes to fade out after it ends
const MIN_CELL_WIDTH = 4;   // highlights are never drawn thinner than this many pixels
const LABEL_WIDTH = 56;     // space on the left for the price labels

let roll;
let animationId = null;

// Styles use !important because the page's own CSS may hide or resize canvases
function getRoll() {
    if (!roll) {
        roll = document.createElement('canvas');

        const styles = {
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            width: '100%',
            height: '320px',
            'max-width': 'none',
            background: '#111',
            'border-radius': '6px'
        };

        for (const [property, value] of Object.entries(styles)) {
            roll.style.setProperty(property, value, 'important');
        }

        info.after(roll);
    }

    return roll;
}

function clearRoll() {
    if (roll) {
        roll.getContext('2d').clearRect(0, 0, roll.width, roll.height);
    }
}

// Never thinner than MIN_CELL_WIDTH, so a one-column note is still visible
function visibleRect(x, y, w, h) {
    if (w < MIN_CELL_WIDTH) {
        x -= (MIN_CELL_WIDTH - w) / 2;
        w = MIN_CELL_WIDTH;
    }

    return { x, y, w, h };
}

// Redraw every frame, in sync with the audio clock
function startRoll(notes, shapes, columnCount, startTime, minPrice, maxPrice) {
    cancelAnimationFrame(animationId);

    const surface = getRoll();
    const context = surface.getContext('2d');

    const totalTime = columnCount * COLUMN_DURATION;

    function frame() {
        let finished = false;

        try {
            // Keep the canvas sharp on high-DPI screens and after resizes
            const ratio = window.devicePixelRatio || 1;
            const w = Math.round(surface.clientWidth * ratio);
            const h = Math.round(surface.clientHeight * ratio);

            if (surface.width !== w || surface.height !== h) {
                surface.width = w;
                surface.height = h;
            }

            context.setTransform(ratio, 0, 0, ratio, 0, 0);

            const width = surface.clientWidth;
            const height = surface.clientHeight;

            context.clearRect(0, 0, width, height);

            // Compensate for audio output delay so visuals match what you hear
            const now = audioContext.currentTime - (audioContext.outputLatency || 0);
            const elapsed = now - startTime;

            finished = elapsed > totalTime + FLASH_TIME + MIN_NOTE_DURATION;

            // Plot area
            const plotLeft = LABEL_WIDTH;
            const plotTop = 8;
            const plotWidth = width - plotLeft - 8;
            const plotHeight = height - plotTop * 2;
            const columnWidth = plotWidth / columnCount;
            const rowHeight = plotHeight / ROWS;

            // Row 0 (lowest price) is at the bottom
            const rowY = row => plotTop + (ROWS - 1 - row) * rowHeight;

            // Faint grid, one line per pitch row
            context.strokeStyle = 'rgba(255, 255, 255, 0.06)';
            context.lineWidth = 1;

            for (let r = 0; r <= ROWS; r++) {
                const y = plotTop + r * rowHeight;

                context.beginPath();
                context.moveTo(plotLeft, y);
                context.lineTo(plotLeft + plotWidth, y);
                context.stroke();
            }

            // Price labels
            context.font = '11px sans-serif';
            context.textBaseline = 'middle';
            context.textAlign = 'right';
            context.fillStyle = 'rgba(255, 255, 255, 0.7)';
            context.fillText(maxPrice.toFixed(4), plotLeft - 6, plotTop + 6);
            context.fillText(minPrice.toFixed(4), plotLeft - 6, plotTop + plotHeight - 6);
            context.textAlign = 'left';

            // Column the scan line is in right now (-1 before the start)
            const progress = Math.min(1, Math.max(0, elapsed / totalTime));
            const currentColumn = elapsed < 0
                ? -1
                : Math.min(columnCount - 1, Math.floor(progress * columnCount));

            // Scan line + the column being read
            if (elapsed >= 0 && elapsed <= totalTime) {
                context.fillStyle = 'rgba(255, 235, 59, 0.12)';
                context.fillRect(plotLeft + currentColumn * columnWidth, plotTop, columnWidth, plotHeight);

                context.strokeStyle = 'rgb(255, 235, 59)';
                context.lineWidth = 1.5;
                context.beginPath();
                context.moveTo(plotLeft + progress * plotWidth, plotTop);
                context.lineTo(plotLeft + progress * plotWidth, plotTop + plotHeight);
                context.stroke();
            }

            // One bar per note, spanning every column it is held for
            for (const note of notes) {
                const time = startTime + note.offset;
                const columns = note.endColumn - note.startColumn + 1;
                const noteEnd = time + columns * COLUMN_DURATION;

                const colour = COLOURS[note.instrument % COLOURS.length];

                const x = plotLeft + note.startColumn * columnWidth;
                const y = rowY(note.row);

                // Every note leaves a faint trace, so you can see what is coming
                let box = visibleRect(x, y, columns * columnWidth, rowHeight);
                context.fillStyle = `rgba(${colour}, 0.12)`;
                context.fillRect(box.x, box.y, box.w, box.h);

                if (now < time || now > noteEnd + FLASH_TIME) continue;

                // Fully lit while sounding, then fades out
                const alpha = now <= noteEnd ? 1 : 1 - (now - noteEnd) / FLASH_TIME;

                // Whole note, dim: shows how long it will be held
                context.fillStyle = `rgba(${colour}, ${0.22 * alpha})`;
                context.fillRect(box.x, box.y, box.w, box.h);

                // Part already played, bright
                const playedColumns = Math.min(columns, Math.max(1, currentColumn - note.startColumn + 1));
                box = visibleRect(x, y, playedColumns * columnWidth, rowHeight);

                context.fillStyle = `rgba(${colour}, ${0.6 * alpha})`;
                context.fillRect(box.x, box.y, box.w, box.h);

                context.strokeStyle = `rgba(${colour}, ${alpha})`;
                context.lineWidth = 2;
                context.strokeRect(box.x, box.y, box.w, box.h);

                // White outline = the cell being played right now
                if (now <= noteEnd) {
                    const head = visibleRect(
                        plotLeft + Math.min(note.endColumn, Math.max(note.startColumn, currentColumn)) * columnWidth,
                        y, columnWidth, rowHeight
                    );

                    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                    context.lineWidth = 1.5;
                    context.strokeRect(head.x, head.y, head.w, head.h);
                }
            }

            // The price data itself as candles: dim until played, then bright
            shapes.forEach((s, col) => {
                if (!s) return;   // rest column

                const cx = plotLeft + (col + 0.5) * columnWidth;
                const a = col <= currentColumn ? 0.9 : 0.25;

                context.strokeStyle = `rgba(255, 255, 255, ${a})`;
                context.fillStyle = `rgba(255, 255, 255, ${a})`;
                context.lineWidth = 1;

                // Wick: low to high
                context.beginPath();
                context.moveTo(cx, rowY(s.high));
                context.lineTo(cx, rowY(s.low) + rowHeight);
                context.stroke();

                // Body: open to close
                const bodyWidth = Math.max(2, columnWidth * 0.6);
                const top = rowY(Math.max(s.open, s.close));
                const bottom = rowY(Math.min(s.open, s.close)) + rowHeight;

                context.fillRect(cx - bodyWidth / 2, top, bodyWidth, bottom - top);
            });

            // Legend: which colour is which instrument
            context.font = '12px sans-serif';
            context.textBaseline = 'middle';

            INSTRUMENTS.forEach((instr, i) => {
                const y = plotTop + 12 + i * 18;

                context.fillStyle = 'rgba(0, 0, 0, 0.6)';
                context.fillRect(plotLeft + 6, y - 8, 90, 16);

                context.fillStyle = `rgb(${COLOURS[i % COLOURS.length]})`;
                context.fillRect(plotLeft + 10, y - 5, 10, 10);

                context.fillStyle = '#fff';
                context.fillText(instr.name.replace(/_/g, ' '), plotLeft + 26, y);
            });

        } catch (err) {
            // Never let a drawing error silently kill the animation
            console.error('Visual error:', err);
        }

        // Stop looping once playback is over, leaving the final picture on screen
        if (!finished) {
            animationId = requestAnimationFrame(frame);
        }
    }

    animationId = requestAnimationFrame(frame);
}
