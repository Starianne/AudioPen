import { Soundfont } from 'https://unpkg.com/smplr@0.16.4/dist/index.mjs';

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const photo = document.getElementById('photo');

const cameraBtn = document.getElementById('cameraBtn');
const onBtn = document.getElementById('onBtn');
const generateBtn = document.getElementById('generateMusicBtn');
const stopBtn = document.getElementById('stopMusicBtn');

let stream;
let audioContext;
const instruments = {};  // smplr instruments, keyed by name (loaded on first use)

// Holds the edge-detected image (this is what's displayed and sonified)
const edgeCanvas = document.createElement('canvas');

// Playback state (used by the on-image overlay)
let noteEvents = [];   // every scheduled note, with its exact source pixel
let startTime = 0;     // audioContext time when column 0 starts
let overlay;           // transparent canvas drawn on top of the photo
let animationId = null;
let playbackGeneration = 0;

// MUSICAL SETTINGS

// SCALES (all in C). Each scale has:
//   label       : text shown in the page
//   notes       : semitone steps above the root note
//   instruments : the instruments used with this scale, ordered LOW to HIGH register.
//                 Notes are assigned by register; an instrument can play
//                 multiple notes in the same chord.
// The key is the <option value> used in the page.
// Any smplr Soundfont name works. Bowed strings and winds hold long notes well;
// percussive ones (piano, vibraphone, guitar) die away while a note is held.
const SCALES = {
    majorPentatonic: {
        label: 'Major pentatonic',
        notes: [0, 2, 4, 7, 9],
        instruments: ['cello', 'clarinet', 'violin', 'flute']
    },
    minorPentatonic: {
        label: 'Minor pentatonic',
        notes: [0, 3, 5, 7, 10],
        instruments: ['bassoon', 'english_horn', 'oboe', 'flute']
    },
    major: {
        label: 'Major',
        notes: [0, 2, 4, 5, 7, 9, 11],
        instruments: ['contrabass', 'french_horn', 'violin', 'flute']
    },
    naturalMinor: {
        label: 'Natural minor',
        notes: [0, 2, 3, 5, 7, 8, 10],
        instruments: ['cello', 'viola', 'english_horn', 'oboe']
    },
    harmonicMinor: {
        label: 'Harmonic minor',
        notes: [0, 2, 3, 5, 7, 8, 11],
        instruments: ['contrabass', 'bassoon', 'violin', 'piccolo']
    },
    dorian: {
        label: 'Dorian',
        notes: [0, 2, 3, 5, 7, 9, 10],
        instruments: ['cello', 'acoustic_guitar_nylon', 'clarinet', 'flute']
    },
    phrygian: {
        label: 'Phrygian',
        notes: [0, 1, 3, 5, 7, 8, 10],
        instruments: ['contrabass', 'trombone', 'english_horn', 'oboe']
    },
    lydian: {
        label: 'Lydian',
        notes: [0, 2, 4, 6, 7, 9, 11],
        instruments: ['cello', 'vibraphone', 'celesta', 'glockenspiel']
    },
    mixolydian: {
        label: 'Mixolydian',
        notes: [0, 2, 4, 5, 7, 9, 10],
        instruments: ['acoustic_bass', 'acoustic_guitar_steel', 'harmonica', 'whistle']
    },
    blues: {
        label: 'Blues',
        notes: [0, 3, 5, 6, 7, 10],
        instruments: ['acoustic_bass', 'electric_guitar_clean', 'harmonica', 'alto_sax']
    },
    wholeTone: {
        label: 'Whole tone',
        notes: [0, 2, 4, 6, 8, 10],
        instruments: ['cello', 'orchestral_harp', 'celesta', 'music_box']
    },
    hirajoshi: {
        label: 'Hirajoshi (Japanese)',
        notes: [0, 2, 3, 7, 8],
        instruments: ['koto', 'shamisen', 'shakuhachi', 'pan_flute']
    },
    chromatic: {
        label: 'Chromatic',
        notes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        instruments: ['contrabass', 'cello', 'violin', 'flute']
    }
};

const DEFAULT_SCALE = 'majorPentatonic';

// The scale control in the page: <select id="scaleSelect"></select>
// Optional. If it is missing, the default scale is used. If it is present but
// empty, it is filled in automatically from SCALES above.
const scaleSelect = document.getElementById('scaleSelect');

if (scaleSelect && scaleSelect.options.length === 0) {
    for (const [key, scale] of Object.entries(SCALES)) {
        scaleSelect.add(new Option(scale.label, key));
    }

    scaleSelect.value = DEFAULT_SCALE;
}

// Colours used to draw each instrument's cells on the image, from the
// lowest-register instrument to the highest (r, g, b)
const VOICE_COLOURS = ['255, 112, 67', '255, 202, 40', '102, 187, 106', '66, 165, 245'];

// Used if an instrument can't be loaded (e.g. a name that doesn't exist)
const FALLBACK_INSTRUMENT = 'acoustic_grand_piano';

// SOUND QUALITY SETTINGS
const KIT = 'MusyngKite';      // smplr's higher-quality sample set ('FluidR3_GM' is smaller but rougher)
const USE_LOOP_DATA = true;    // lets sustained instruments hold notes as long as needed instead of
                               // the sample simply ending (experimental in smplr; set false if you hear clicks)
const FADE_OUT_TIME = 1.5;     // seconds an instrument takes to fade away once its edge ends (the image goes black there)
const MASTER_VOLUME = 0.85;
const REVERB_MIX = 0.3;        // 0 = dry, higher = more room
const REVERB_SECONDS = 2.5;    // length of the reverb tail
const VOICE_PANS = [-0.6, -0.2, 0.2, 0.6];  // stereo position of each voice, lowest to highest
const HUMANIZE_TIME = 0.012;   // random timing wobble per note (seconds), stops it sounding mechanical
const HUMANIZE_VELOCITY = 6;   // random loudness wobble per note (MIDI velocity)

// Instruments whose notes naturally die away. They must NOT be looped, or they
// would ring forever like an organ.
const PERCUSSIVE = new Set([
    'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_clean',
    'acoustic_bass', 'vibraphone', 'celesta', 'glockenspiel', 'music_box',
    'orchestral_harp', 'koto', 'shamisen'
]);

// Shared audio chain: each instrument -> its own stereo pan -> master -> compressor -> speakers,
// with a send from every pan into one shared reverb.
let master;       // master volume
let reverbSend;   // level of signal sent to the reverb
const voiceNodes = {};   // stereo panner for each instrument, keyed by name

// Build a reverb impulse response: stereo noise that fades out smoothly
function makeReverbImpulse(seconds) {
    const rate = audioContext.sampleRate;
    const length = Math.floor(rate * seconds);
    const impulse = audioContext.createBuffer(2, length, rate);

    for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);

        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        }
    }

    return impulse;
}

function setupAudioGraph() {
    if (master) return;

    // Compressor keeps dense chords plus reverb from distorting
    const compressor = audioContext.createDynamicsCompressor();
    compressor.connect(audioContext.destination);

    master = audioContext.createGain();
    master.gain.value = MASTER_VOLUME;
    master.connect(compressor);

    const reverb = audioContext.createConvolver();
    reverb.buffer = makeReverbImpulse(REVERB_SECONDS);
    reverb.connect(master);

    reverbSend = audioContext.createGain();
    reverbSend.gain.value = REVERB_MIX;
    reverbSend.connect(reverb);
}

// What is in use right now (set from the page when Generate is pressed)
let currentScale = [];   // semitone steps of the selected scale
let INSTRUMENTS = [];    // [{ name, colour }] of the selected scale, low to high

function applySelectedScale() {
    const key = scaleSelect && SCALES[scaleSelect.value] ? scaleSelect.value : DEFAULT_SCALE;
    const scale = SCALES[key];

    currentScale = scale.notes;

    INSTRUMENTS = scale.instruments.map((name, i) => ({
        name,
        colour: VOICE_COLOURS[i % VOICE_COLOURS.length]
    }));
}

applySelectedScale();

// Load the samples for a list of instruments (each is only downloaded once).
// If one can't be loaded, the fallback instrument plays in its place.
function createInstrument(name) {
    // Each instrument gets its own stereo pan feeding the shared master + reverb
    if (!voiceNodes[name]) {
        const pan = audioContext.createStereoPanner();
        pan.connect(master);
        pan.connect(reverbSend);

        voiceNodes[name] = pan;
    }

    return new Soundfont(audioContext, {
        instrument: name,
        kit: KIT,
        decayTime: FADE_OUT_TIME,
        destination: voiceNodes[name],
        loadLoopData: USE_LOOP_DATA && !PERCUSSIVE.has(name)
    });
}

async function loadInstruments(list) {
    for (const { name } of list) {
        if (!instruments[name]) {
            instruments[name] = createInstrument(name);
        }
    }

    // Spread the voices across the stereo field, lowest on the left
    list.forEach(({ name }, i) => {
        voiceNodes[name].pan.value = VOICE_PANS[i % VOICE_PANS.length];
    });

    await Promise.all(list.map(async ({ name }) => {
        try {
            await instruments[name].load;
        } catch (err) {
            console.warn(`Could not load "${name}"; using ${FALLBACK_INSTRUMENT} instead.`, err);

            if (!instruments[FALLBACK_INSTRUMENT]) {
                instruments[FALLBACK_INSTRUMENT] = createInstrument(FALLBACK_INSTRUMENT);
            }

            await instruments[FALLBACK_INSTRUMENT].load;
            instruments[name] = instruments[FALLBACK_INSTRUMENT];
        }
    }));
}

// SCAN SETTINGS
// The image is read left to right as a scan line. Each COLUMN is one moment in
// time; each ROW is one pitch (top of image = highest note). Where an edge
// continues along the same row with the same colour, ONE note is held for its
// whole length. A new note starts when the edge changes row or colour.
const COLUMNS = 128;            // time resolution (columns across the image)
const ROWS = 20;                // pitch resolution (20 notes of the chosen scale)
const COLUMN_DURATION = 0.15;   // seconds per column -> 128 x 0.15 = 19.2 s total
const MIN_NOTE_DURATION = 0.6;  // shortest a note can ring (single-column notes)
const THRESHOLD = 0.3;          // an edge must be this fraction of a "strong" edge to start a note
const MIN_STRENGTH = 20;        // absolute floor so camera noise stays silent

// CONTINUITY SETTINGS
const CONTINUE_CUTOFF = 0.6;    // a held note survives down to 60% of the normal cutoff
const COLOUR_TOLERANCE = 35;    // hue change (degrees) that counts as a "colour change"
const NEUTRAL_SATURATION = 0.2; // below this saturation an edge counts as colourless (white)

// OVERLAY SETTINGS
const FLASH_TIME = FADE_OUT_TIME; // the highlight fades out over the same time as the sound
const MIN_CELL_WIDTH = 8;       // highlights are never drawn thinner than this many pixels

// EDGE KERNELS (Sobel)
// Horizontal edges: responds to brightness changes between rows.
const EDGE_KERNEL_H = [
    -1, -2, -1,
     0,  0,  0,
     1,  2,  1
];

// Vertical edges: responds to brightness changes between columns.
const EDGE_KERNEL_V = [
    -1, 0, 1,
    -2, 0, 2,
    -1, 0, 1
];

// EDGE IMAGE TUNING
const EDGE_GAIN = 2;     // overall brightness of edges (raise if too dark)
const COLOUR_GAIN = 3;   // colour saturation (raise for stronger colour, 0 = white edges)
const BRIGHTNESS_CUTOFF = 40; // pixels dimmer than this (0-255) are set to pure black (0 = keep everything)

// Convert a scale degree into a MIDI note
function getScaleNote(degree) {
    const octave = Math.floor(degree / currentScale.length);
    const note = currentScale[degree % currentScale.length];

    return 48 + octave * 12 + note;
}

// Convolve the R, G and B channels separately with one 3x3 kernel.
// Returns a Float32Array of width*height*3 absolute edge strengths (R, G, B per pixel).
function convolveChannels(imageData, kernel) {
    const { width, height, data } = imageData;
    const result = new Float32Array(width * height * 3);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {

            // One running sum per colour channel
            let sumR = 0, sumG = 0, sumB = 0;

            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {

                    // Clamp coordinates at the image borders
                    const px = Math.min(width - 1, Math.max(0, x + kx));
                    const py = Math.min(height - 1, Math.max(0, y + ky));

                    const weight = kernel[(ky + 1) * 3 + (kx + 1)];
                    const p = (py * width + px) * 4;

                    sumR += data[p] * weight;
                    sumG += data[p + 1] * weight;
                    sumB += data[p + 2] * weight;
                }
            }

            const o = (y * width + x) * 3;
            result[o] = Math.abs(sumR);
            result[o + 1] = Math.abs(sumG);
            result[o + 2] = Math.abs(sumB);
        }
    }

    return result;
}

// Turn three per-channel edge strengths into one RGB colour (0-255 each).
// BRIGHTNESS comes from how strong the edge is.
// COLOUR comes from which channels changed LEAST (the ink colour).
function edgeToColour(aR, aG, aB) {
    const m = Math.max(aR, aG, aB);   // strongest channel
    const mn = Math.min(aR, aG, aB);  // weakest channel

    const brightness = Math.min(255, m * EDGE_GAIN);

    // Start white; this is also what neutral edges (glare) stay.
    let r = 1, g = 1, b = 1;

    if (m > 0 && m > mn) {
        // 0 = all channels changed equally, 1 = only one channel changed
        const spread = (m - mn) / m;

        // Complement of each channel, normalised so the brightest is 1
        const cR = (m - aR) / m / spread;
        const cG = (m - aG) / m / spread;
        const cB = (m - aB) / m / spread;

        // How much to trust the colour: neutral edges -> white
        const t = Math.min(1, spread * COLOUR_GAIN);

        r = (1 - t) + t * cR;
        g = (1 - t) + t * cG;
        b = (1 - t) + t * cB;
    }

    return [brightness * r, brightness * g, brightness * b];
}

// Build the coloured edge image: horizontal and vertical edge versions
// are each coloured, then summed together (clamped to 255).
// Returns a new ImageData, A = 255.
function applyEdgeKernel(imageData) {
    const { width, height } = imageData;
    const output = new ImageData(width, height);
    const out = output.data;

    const horizontal = convolveChannels(imageData, EDGE_KERNEL_H);
    const vertical = convolveChannels(imageData, EDGE_KERNEL_V);

    for (let n = 0; n < width * height; n++) {
        const o = n * 3;
        const i = n * 4;

        const h = edgeToColour(horizontal[o], horizontal[o + 1], horizontal[o + 2]);
        const v = edgeToColour(vertical[o], vertical[o + 1], vertical[o + 2]);

        // Sum the two versions
        const r = Math.min(255, h[0] + v[0]);
        const g = Math.min(255, h[1] + v[1]);
        const b = Math.min(255, h[2] + v[2]);

        // Remove faint detail: dim pixels become exactly zero (black)
        const brightness = r * 0.299 + g * 0.587 + b * 0.114;

        if (brightness < BRIGHTNESS_CUTOFF) {
            out[i] = 0;
            out[i + 1] = 0;
            out[i + 2] = 0;
        } else {
            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
        }

        out[i + 3] = 255;
    }

    return output;
}

// Turn camera on
onBtn.addEventListener('click', async () => {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: true
        });

        video.srcObject = stream;
        await video.play();

        onBtn.disabled = true;
        cameraBtn.disabled = false;

    } catch (err) {
        console.error('Camera error:', err);
    }
});

// Take photograph
cameraBtn.addEventListener('click', () => {
    if (!video.videoWidth) return;

    stopMusic();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext('2d');

    context.drawImage(video, 0, 0);

    // Build the edge image from the photograph's R values
    const original = context.getImageData(
        0, 0,
        canvas.width,
        canvas.height
    );

    const edges = applyEdgeKernel(original);

    edgeCanvas.width = canvas.width;
    edgeCanvas.height = canvas.height;
    edgeCanvas.getContext('2d').putImageData(edges, 0, 0);

    // Display the edge image instead of the original photograph
    photo.src = edgeCanvas.toDataURL('image/png');


    generateBtn.disabled = false;
});

// ---------------------------------------------------------------
// MUSIC
// ---------------------------------------------------------------

// Hue of an RGB colour in degrees (0-360), or -1 if it is basically white/grey
function getHue(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (max === 0 || (max - min) / max < NEUTRAL_SATURATION) {
        return -1;
    }

    const d = max - min;
    let hue;

    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;

    return (hue * 60 + 360) % 360;
}

// Do two hues count as the same colour? (-1 = neutral)
function sameColour(a, b) {
    if (a === -1 || b === -1) return a === b;

    const difference = Math.abs(a - b);

    return Math.min(difference, 360 - difference) <= COLOUR_TOLERANCE;
}

// Analyse the edge image and build the list of notes.
// Works on the FULL-resolution edge image, so thin edges are never skipped.
function buildNotes() {
    const width = edgeCanvas.width;
    const height = edgeCanvas.height;

    const pixels = edgeCanvas
        .getContext('2d')
        .getImageData(0, 0, width, height).data;

    // For every grid cell keep the STRONGEST edge pixel in it (max pooling)
    // and remember exactly where that pixel is.
    const cellCount = COLUMNS * ROWS;
    const strength = new Float32Array(cellCount);
    const pixelX = new Float32Array(cellCount);
    const pixelY = new Float32Array(cellCount);
    const hue = new Float32Array(cellCount).fill(-1);

    // Only the part of the image that is actually visible on screen is used.
    // Anything cropped off by the CSS (e.g. object-fit: cover) makes no sound.
    const area = getVisibleArea().region;

    let x0 = Math.max(0, Math.round(area.x));
    let y0 = Math.max(0, Math.round(area.y));
    let x1 = Math.min(width, Math.round(area.x + area.width));
    let y1 = Math.min(height, Math.round(area.y + area.height));

    // If the geometry can't be worked out, fall back to the whole image
    if (!(x1 > x0) || !(y1 > y0)) {
        x0 = 0;
        y0 = 0;
        x1 = width;
        y1 = height;
    }

    const regionWidth = x1 - x0;
    const regionHeight = y1 - y0;

    for (let y = y0; y < y1; y++) {

        const row = Math.min(ROWS - 1, Math.floor((y - y0) * ROWS / regionHeight));

        for (let x = x0; x < x1; x++) {

            const column = Math.min(COLUMNS - 1, Math.floor((x - x0) * COLUMNS / regionWidth));

            const i = (y * width + x) * 4;

            // Edge strength = luminance of the edge pixel
            const s = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;

            const cell = row * COLUMNS + column;

            if (s > strength[cell]) {
                strength[cell] = s;
                pixelX[cell] = x;
                pixelY[cell] = y;
                hue[cell] = getHue(pixels[i], pixels[i + 1], pixels[i + 2]);
            }
        }
    }

    // "Strong edge" reference = 98th percentile of cell strengths.
    // (Using the single brightest value would let one glare spot silence everything else.)
    const sorted = strength.slice().sort();
    const reference = Math.max(1, sorted[Math.floor(sorted.length * 0.98)]);

    const cutoff = Math.max(MIN_STRENGTH, reference * THRESHOLD);

    const notes = [];
    let active = [];   // notes still being held from the previous column

    for (let column = 0; column < COLUMNS; column++) {

        // Collect every row in this column that has an edge strong enough
        const candidates = [];

        for (let row = 0; row < ROWS; row++) {
            const cell = row * COLUMNS + column;

            // Is this the continuation of a note already sounding
            // (same row, same colour)?
            const holding = active.find(n => n.row === row && sameColour(n.hue, hue[cell]));

            // Held notes get a lower cutoff, so one weak pixel in a long edge
            // does not chop the note into pieces.
            const needed = holding ? cutoff * CONTINUE_CUTOFF : cutoff;

            if (strength[cell] >= needed) {
                candidates.push({
                    row,
                    cell,
                    holding
                });
            }
        }

        // Every qualifying row contributes a note; instruments can play
        // multiple notes at once, so do not discard edges based on voice count.
        const chosen = candidates;

        const nextActive = [];

        // 1) Notes that simply carry on keep their instrument
        for (const c of chosen) {
            if (!c.holding) continue;

            const note = c.holding;

            note.endColumn = column;
            note.peak = Math.max(note.peak, strength[c.cell]);
            note.points.push({
                column,
                x: (pixelX[c.cell] - x0 + 0.5) / regionWidth,
                y: (pixelY[c.cell] - y0 + 0.5) / regionHeight
            });

            nextActive.push(note);
        }

        // 2) New notes pick an instrument that suits their register.
        for (const c of chosen) {
            if (c.holding) continue;

            // Top row = highest pitch
            const degree = ROWS - 1 - c.row;

            const pick = Math.min(
                INSTRUMENTS.length - 1,
                Math.floor(degree * INSTRUMENTS.length / ROWS)
            );

            const note = {
                row: c.row,
                midi: getScaleNote(degree),
                instrument: pick,            // index into INSTRUMENTS
                hue: hue[c.cell],
                startColumn: column,
                endColumn: column,
                peak: strength[c.cell],
                points: [{
                    column,
                    x: (pixelX[c.cell] - x0 + 0.5) / regionWidth,
                    y: (pixelY[c.cell] - y0 + 0.5) / regionHeight
                }]
            };

            notes.push(note);
            nextActive.push(note);
        }

        active = nextActive;
    }

    // Final timing and loudness for each note
    for (const note of notes) {
        const columns = note.endColumn - note.startColumn + 1;

        note.offset = note.startColumn * COLUMN_DURATION;
        note.runTime = columns * COLUMN_DURATION;          // how long the edge lasts
        note.duration = Math.max(note.runTime, MIN_NOTE_DURATION);

        // Stronger edge = louder note (MIDI velocity 30-127)
        note.velocity = Math.round(30 + Math.min(1, note.peak / reference) * 97);
    }

    return notes;
}

// Generate music from the edge image
generateBtn.addEventListener('click', async () => {

    // Stop previous composition
    stopMusic();
    const generation = playbackGeneration;

    window.dispatchEvent(new CustomEvent('audiopen:play', { detail: 'image' }));

    // Use whichever scale (and its instruments) is selected in the page
    applySelectedScale();

    // Create audio context
    if (!audioContext) {
        audioContext = new AudioContext();
    }

    setupAudioGraph();

    await audioContext.resume();
    if (generation !== playbackGeneration) return;

    // Load the selected scale's instruments
    await loadInstruments(INSTRUMENTS);
    if (generation !== playbackGeneration) return;

    master.gain.cancelScheduledValues(audioContext.currentTime);
    master.gain.setValueAtTime(MASTER_VOLUME, audioContext.currentTime);

    noteEvents = buildNotes();

    startTime = audioContext.currentTime + 0.1;

    for (const note of noteEvents) {
        note.time = startTime + note.offset;
    }

    console.log(`Generated ${noteEvents.length} notes!`);

    // Start the on-screen highlighting first, so it shows even if audio has a problem
    startOverlay();

    // Schedule each note once, held for the whole length of its edge
    try {
        for (const note of noteEvents) {
            // Tiny random timing and loudness changes make it sound played, not typed
            const wobbleTime = (Math.random() * 2 - 1) * HUMANIZE_TIME;
            const wobbleVelocity = Math.round((Math.random() * 2 - 1) * HUMANIZE_VELOCITY);

            instruments[INSTRUMENTS[note.instrument].name].start({
                note: note.midi,
                time: Math.max(audioContext.currentTime, note.time + wobbleTime),
                duration: note.duration,          // sounds for as long as the edge lasts...
                decayTime: FADE_OUT_TIME,         // ...then fades away slowly
                velocity: Math.max(1, Math.min(127, note.velocity + wobbleVelocity))
            });
        }
    } catch (err) {
        console.error('Audio scheduling error:', err);
    }
});

// ---------------------------------------------------------------
// OVERLAY (shows exactly where each note comes from)
// ---------------------------------------------------------------

// Work out which part of the image is actually VISIBLE on screen.
//
// The CSS (width, aspect-ratio, object-fit, object-position) decides how the
// picture is scaled and cropped inside its box. This reproduces that, and returns:
//   left / top / width / height : the visible area, in screen pixels
//   region                      : the same area in IMAGE pixels
// so the music is built only from what the user can see, and the overlay
// lines up exactly with it.
function getVisibleArea() {
    const box = photo.getBoundingClientRect();
    const style = getComputedStyle(photo);

    // Content box (inside borders and padding)
    const boxLeft = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const boxTop = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const boxWidth = box.width
        - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
        - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const boxHeight = box.height
        - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
        - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);

    // Size of the real picture, in image pixels
    const imageWidth = edgeCanvas.width;
    const imageHeight = edgeCanvas.height;

    // How object-fit scales the picture (default 'fill' stretches it to the box)
    let scaleX = boxWidth / imageWidth;
    let scaleY = boxHeight / imageHeight;

    switch (style.objectFit) {
        case 'contain':
            scaleX = scaleY = Math.min(scaleX, scaleY);
            break;
        case 'cover':
            scaleX = scaleY = Math.max(scaleX, scaleY);
            break;
        case 'none':
            scaleX = scaleY = 1;
            break;
        case 'scale-down':
            scaleX = scaleY = Math.min(1, Math.min(scaleX, scaleY));
            break;
    }

    const drawnWidth = imageWidth * scaleX;
    const drawnHeight = imageHeight * scaleY;

    // object-position decides where the picture sits when it doesn't fit exactly
    // (default 50% 50% = centred). Values are percentages or pixels.
    const [positionX, positionY] = style.objectPosition.split(' ');

    function resolve(token, freeSpace) {
        const value = parseFloat(token);

        if (Number.isNaN(value)) return freeSpace / 2;

        return token.endsWith('%') ? freeSpace * value / 100 : value;
    }

    const drawnLeft = boxLeft + resolve(positionX, boxWidth - drawnWidth);
    const drawnTop = boxTop + resolve(positionY, boxHeight - drawnHeight);

    // Visible part = where the drawn picture overlaps the box
    const left = Math.max(boxLeft, drawnLeft);
    const top = Math.max(boxTop, drawnTop);
    const right = Math.min(boxLeft + boxWidth, drawnLeft + drawnWidth);
    const bottom = Math.min(boxTop + boxHeight, drawnTop + drawnHeight);

    return {
        left,
        top,
        width: right - left,
        height: bottom - top,

        // The same area expressed in image pixels
        region: {
            x: (left - drawnLeft) / scaleX,
            y: (top - drawnTop) / scaleY,
            width: (right - left) / scaleX,
            height: (bottom - top) / scaleY
        }
    };
}

// Transparent canvas covering the screen, drawn on top of everything.
// Styles are set with !important because the page's own CSS may hide or
// resize every <canvas> (the capture canvas is usually hidden), which would
// also hide this one.
function getOverlay() {
    if (!overlay) {
        overlay = document.createElement('canvas');

        const styles = {
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            position: 'fixed',
            left: '0',
            top: '0',
            width: '100vw',
            height: '100vh',
            'max-width': 'none',
            'pointer-events': 'none',
            'z-index': '2147483647'
        };

        for (const [property, value] of Object.entries(styles)) {
            overlay.style.setProperty(property, value, 'important');
        }

        document.body.appendChild(overlay);
    }

    return overlay;
}

function clearOverlay() {
    if (overlay) {
        overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    }
}

// Draw a rectangle that is never thinner than MIN_CELL_WIDTH (so a one-column
// cell is still easy to see). The extra width is added equally on both sides.
function visibleRect(x, y, w, h) {
    if (w < MIN_CELL_WIDTH) {
        x -= (MIN_CELL_WIDTH - w) / 2;
        w = MIN_CELL_WIDTH;
    }

    return { x, y, w, h };
}

// Redraw the overlay every frame, in sync with the audio clock
function startOverlay() {
    cancelAnimationFrame(animationId);

    const surface = getOverlay();
    const context = surface.getContext('2d');

    const totalTime = COLUMNS * COLUMN_DURATION;

    function frame() {
        context.save();

        try {
            // Keep the canvas sharp on high-DPI screens and after window resizes
            const ratio = window.devicePixelRatio || 1;
            const w = Math.round(window.innerWidth * ratio);
            const h = Math.round(window.innerHeight * ratio);

            if (surface.width !== w || surface.height !== h) {
                surface.width = w;
                surface.height = h;
            }

            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.clearRect(0, 0, window.innerWidth, window.innerHeight);

            // Compensate for audio output delay so visuals match what you hear
            const now = audioContext.currentTime - (audioContext.outputLatency || 0);
            const elapsed = now - startTime;

            // Finished
            if (elapsed > totalTime + FLASH_TIME + MIN_NOTE_DURATION) {
                return;
            }

            const rect = getVisibleArea();

            // Only draw inside the visible image area, so nothing can spill
            // above, below or beside the picture
            context.beginPath();
            context.rect(rect.left, rect.top, rect.width, rect.height);
            context.clip();

            const columnWidth = rect.width / COLUMNS;
            const rowHeight = rect.height / ROWS;

            // Column the scan line is in right now (-1 before the start)
            const progress = Math.min(1, Math.max(0, elapsed / totalTime));
            const currentColumn = elapsed < 0
                ? -1
                : Math.min(COLUMNS - 1, Math.floor(progress * COLUMNS));

            // Scan line + the column being read
            if (elapsed >= 0 && elapsed <= totalTime) {
                context.fillStyle = 'rgba(255, 235, 59, 0.15)';
                context.fillRect(rect.left + currentColumn * columnWidth, rect.top, columnWidth, rect.height);

                context.strokeStyle = 'rgb(255, 235, 59)';
                context.lineWidth = 1.5;
                context.beginPath();
                context.moveTo(rect.left + progress * rect.width, rect.top);
                context.lineTo(rect.left + progress * rect.width, rect.top + rect.height);
                context.stroke();
            }

            // One bar per note, spanning every column the note is held for,
            // coloured by the instrument playing it.
            for (const note of noteEvents) {
                const noteEnd = note.time + note.runTime;

                if (now < note.time || now > noteEnd + FLASH_TIME) continue;

                // Fully lit while sounding, then fades out
                const alpha = now <= noteEnd ? 1 : 1 - (now - noteEnd) / FLASH_TIME;

                const colour = INSTRUMENTS[note.instrument].colour;
                const columns = note.endColumn - note.startColumn + 1;

                const x = rect.left + note.startColumn * columnWidth;
                const y = rect.top + note.row * rowHeight;

                // Whole note, dim: shows how long it will be held
                let box = visibleRect(x, y, columns * columnWidth, rowHeight);
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
                        rect.left + Math.min(note.endColumn, Math.max(note.startColumn, currentColumn)) * columnWidth,
                        y, columnWidth, rowHeight
                    );

                    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                    context.lineWidth = 1.5;
                    context.strokeRect(head.x, head.y, head.w, head.h);
                }

                // White dots = the exact edge pixels the note follows (up to now)
                context.fillStyle = `rgba(255, 255, 255, ${alpha})`;

                for (const p of note.points) {
                    if (p.column > currentColumn) break;

                    context.beginPath();
                    context.arc(
                        rect.left + p.x * rect.width,
                        rect.top + p.y * rect.height,
                        1.5, 0, Math.PI * 2
                    );
                    context.fill();
                }
            }

            // Legend: which colour is which instrument
            context.font = '12px sans-serif';
            context.textBaseline = 'middle';

            INSTRUMENTS.forEach((instr, i) => {
                const y = rect.top + 14 + i * 18;

                context.fillStyle = 'rgba(0, 0, 0, 0.6)';
                context.fillRect(rect.left + 6, y - 8, 110, 16);

                context.fillStyle = `rgb(${instr.colour})`;
                context.fillRect(rect.left + 10, y - 5, 10, 10);

                context.fillStyle = '#fff';
                context.fillText(instr.name.replace(/_/g, ' '), rect.left + 26, y);
            });

        } catch (err) {
            // Never let a drawing error silently kill the animation
            console.error('Overlay error:', err);
        } finally {
            context.restore();
        }

        animationId = requestAnimationFrame(frame);
    }

    animationId = requestAnimationFrame(frame);
}

// Stop playback
function stopMusic() {
    playbackGeneration++;

    Object.values(instruments).forEach(i => i.stop());

    if (master && audioContext) {
        master.gain.cancelScheduledValues(audioContext.currentTime);
        master.gain.setValueAtTime(0, audioContext.currentTime);
    }

    noteEvents = [];
    cancelAnimationFrame(animationId);
    clearOverlay();
}

stopBtn.addEventListener('click', stopMusic);

window.addEventListener('audiopen:play', e => { if (e.detail !== 'image') stopMusic(); });

const imageInput = document.getElementById("imageInput");

imageInput.addEventListener("change", (event) => {
    const file = event.target.files[0];

    if (!file) return;

    event.target.value = '';

    const img = new Image();

    img.onload = () => {
        stopMusic();

        canvas.width = img.width;
        canvas.height = img.height;

        const context = canvas.getContext("2d");
        context.drawImage(img, 0, 0);

        const original = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height
        );

        const edges = applyEdgeKernel(original);

        edgeCanvas.width = canvas.width;
        edgeCanvas.height = canvas.height;
        edgeCanvas.getContext("2d").putImageData(edges, 0, 0);

        photo.src = edgeCanvas.toDataURL("image/png");

        generateBtn.disabled = false;
    };

    img.src = URL.createObjectURL(file);
});