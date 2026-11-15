const fileInput = document.getElementById('fileInput');
const positionSlider = document.getElementById('positionSlider');
const generateBtn = document.getElementById('generateMusicBtn2');
const stopBtn = document.getElementById('stopMusicBtn2');
const info = document.getElementById('info');

let audioContext;
let activeOscillators = [];
let loadedFile = null;

// MUSICAL SETTINGS
const SCALE = [0, 2, 4, 7, 9];      // C major pentatonic
const SCALE_DEGREES = 15;           // pitch range: 3 octaves
const BASE_MIDI = 48;
const NUM_BARS = 128;               // how many rows become notes
const CHUNK_BYTES = 64 * 1024;      // only read a small slice of a huge file
const NOTE_DURATION = 0.15;
const REST_GAP_SECONDS = 30;        // a gap this long in the data adds a rest

// Convert a scale degree into a MIDI note (same as the image version)
function getScaleNote(degree) {
    const octave = Math.floor(degree / SCALE.length);
    const note = SCALE[degree % SCALE.length];
    return BASE_MIDI + octave * 12 + note;
}

function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

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

function playNote(midi, time, duration, waveform, peakGain) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = waveform;
    oscillator.frequency.value = midiToFrequency(midi);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peakGain, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration * 0.9);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(time);
    oscillator.stop(time + duration);

    activeOscillators.push(oscillator);
}

fileInput.addEventListener('change', () => {
    loadedFile = fileInput.files[0] || null;
    generateBtn.disabled = !loadedFile;
    info.textContent = loadedFile ? `Loaded ${loadedFile.name}` : '';
});

generateBtn.addEventListener('click', async () => {
    if (!loadedFile) return;

    stopMusic();

    if (!audioContext) {
        audioContext = new AudioContext();
    }
    await audioContext.resume();

    const rows = await readWindow(loadedFile, positionSlider.value / 100);
    if (rows.length < 2) {
        info.textContent = 'Not enough valid rows at this position.';
        return;
    }

    // Normalise within this window, like scaling brightness to 0-255
    const minPrice = Math.min(...rows.map(r => r.low));
    const maxPrice = Math.max(...rows.map(r => r.high));
    const priceSpan = (maxPrice - minPrice) || 1;

    const maxRange = Math.max(...rows.map(r => r.high - r.low)) || 1;
    const sortedVols = rows.map(r => r.vol).sort((a, b) => a - b);
    const medianVol = sortedVols[Math.floor(sortedVols.length / 2)];

    const startTime = audioContext.currentTime + 0.1;
    let step = 0;
    let noteCount = 0;

    rows.forEach((row, i) => {
        // Long quiet gap in the market -> a rest in the music
        if (i > 0 && row.t - rows[i - 1].t >= REST_GAP_SECONDS) {
            step++;
        }

        // Price level -> pitch (like brightness)
        const degree = Math.round(
            ((row.close - minPrice) / priceSpan) * (SCALE_DEGREES - 1)
        );
        const midi = getScaleNote(degree);

        // Direction -> timbre (like hue): up = triangle, down = sine
        const waveform = row.close > row.open ? 'triangle' : 'sine';

        // Volatility (high - low) -> loudness
        const rangeNorm = (row.high - row.low) / maxRange;
        const peakGain = 0.06 + rangeNorm * 0.12;

        const noteTime = startTime + step * NOTE_DURATION;
        playNote(midi, noteTime, NOTE_DURATION, waveform, peakGain);
        noteCount++;

        // Busier than usual bar (more ticks) -> add a harmony note above
        if (row.vol > medianVol) {
            playNote(
                getScaleNote(Math.min(degree + 2, SCALE_DEGREES + 2)),
                noteTime, NOTE_DURATION, 'sine', peakGain * 0.6
            );
            noteCount++;
        }

        step++;
    });

    const from = new Date(rows[0].t * 1000).toISOString();
    const to = new Date(rows[rows.length - 1].t * 1000).toISOString();
    info.textContent =
        `${rows.length} bars, ${noteCount} notes\n` +
        `${from} to ${to}\n` +
        `Price range ${minPrice.toFixed(4)} to ${maxPrice.toFixed(4)}`;
});

function stopMusic() {
    activeOscillators.forEach(oscillator => {
        try {
            oscillator.stop();
        } catch (err) {
            // Oscillator may already have stopped
        }
    });
    activeOscillators = [];
}

stopBtn.addEventListener('click', stopMusic);