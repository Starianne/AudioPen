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
let instrument;      // smplr instrument (sampled sounds)
let loadedName;      // name of the instrument currently loaded

// Position marker (shows which part of the image is playing)
let marker;
let noteEvents = []; // { time, x, y } for every scheduled note
let animationId = null;

// Holds the edge-detected image (this is what's displayed and sonified)
const edgeCanvas = document.createElement('canvas');

// MUSICAL SETTINGS
const SCALE = [0, 2, 4, 7, 9]; // C major pentatonic
const IMAGE_WIDTH = 32;
const IMAGE_HEIGHT = 16;
const NOTE_DURATION = 0.12;
const BPM = 120;

// INSTRUMENT: any smplr Soundfont name, e.g. 'marimba', 'acoustic_grand_piano',
// 'violin', 'flute', 'xylophone', 'music_box', 'acoustic_guitar_nylon'
const INSTRUMENT = 'marimba';

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

// Convert a scale degree into a MIDI note
function getScaleNote(degree) {
    const octave = Math.floor(degree / SCALE.length);
    const note = SCALE[degree % SCALE.length];

    return 48 + octave * 12 + note;
}

// Convert MIDI note to frequency
function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
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
        out[i] = Math.min(255, h[0] + v[0]);
        out[i + 1] = Math.min(255, h[1] + v[1]);
        out[i + 2] = Math.min(255, h[2] + v[2]);
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

// Generate music from the edge image
generateBtn.addEventListener('click', async () => {

    // Stop previous composition
    stopMusic();

    // Create audio context
    if (!audioContext) {
        audioContext = new AudioContext();
    }

    await audioContext.resume();

    // Load the instrument samples (only again if INSTRUMENT changed)
    if (!instrument || loadedName !== INSTRUMENT) {
        instrument = new Soundfont(audioContext, { instrument: INSTRUMENT });
        loadedName = INSTRUMENT;
    }

    await instrument.load;

    // Resize edge image to 32 x 16
    const smallCanvas = document.createElement('canvas');

    smallCanvas.width = IMAGE_WIDTH;
    smallCanvas.height = IMAGE_HEIGHT;

    const smallContext = smallCanvas.getContext('2d');

    smallContext.drawImage(
        edgeCanvas,
        0, 0,
        IMAGE_WIDTH,
        IMAGE_HEIGHT
    );

    // Extract pixel data
    const imageData = smallContext.getImageData(
        0, 0,
        IMAGE_WIDTH,
        IMAGE_HEIGHT
    );

    const pixels = imageData.data;

    // Schedule music
    const startTime = audioContext.currentTime + 0.1;

    let noteIndex = 0;
    noteEvents = [];

    for (let y = 0; y < IMAGE_HEIGHT; y++) {

        for (let x = 0; x < IMAGE_WIDTH; x++) {

            const index = (y * IMAGE_WIDTH + x) * 4;

            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            const alpha = pixels[index + 3];

            // Overall edge strength across all three channels
            const edge = (red * 0.299 + green * 0.587 + blue * 0.114);

            // Ignore transparent pixels
            if (alpha === 0) continue;

            // Convert edge strength into a musical scale degree
            const edgeDegree = Math.round(
                (edge / 255) * 14
            );

            // Vertical position changes octave
            const verticalDegree = Math.round(
                (1 - y / (IMAGE_HEIGHT - 1)) * 5
            );

            const midiNote = getScaleNote(
                edgeDegree + verticalDegree
            );

            // Note timing
            const noteTime =
                startTime + noteIndex * NOTE_DURATION;

            // Stronger edges play louder (MIDI velocity 30-127)
            const velocity = Math.round(30 + (edge / 255) * 97);

            instrument.start({
                note: midiNote,
                time: noteTime,
                duration: NOTE_DURATION,
                velocity: velocity
            });

            // Remember which cell of the image this note came from
            noteEvents.push({ time: noteTime, x: x, y: y });

            noteIndex++;
        }
    }

    console.log(`Generated ${noteIndex} notes!`);

    startMarker();
});

// Create the highlight box that sits on top of the displayed image
function getMarker() {
    if (!marker) {
        marker = document.createElement('div');

        marker.style.position = 'absolute';
        marker.style.pointerEvents = 'none';
        marker.style.boxSizing = 'border-box';
        marker.style.border = '2px solid #ffeb3b';
        marker.style.background = 'rgba(255, 235, 59, 0.35)';
        marker.style.display = 'none';

        // The marker is positioned relative to the image's parent element
        const parent = photo.parentElement;

        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        parent.appendChild(marker);
    }

    return marker;
}

// Move the marker to whichever note is sounding right now
function startMarker() {
    cancelAnimationFrame(animationId);

    const box = getMarker();
    let next = 0; // index of the first note that hasn't started yet

    function frame() {
        // Compensate for audio output delay so the marker lines up with what you hear
        const now = audioContext.currentTime - (audioContext.outputLatency || 0);

        // Advance past every note whose start time has passed
        while (next < noteEvents.length && noteEvents[next].time <= now) {
            next++;
        }

        const last = noteEvents[noteEvents.length - 1];

        // Finished: hide the marker and stop animating
        if (last && now > last.time + NOTE_DURATION) {
            box.style.display = 'none';
            return;
        }

        // The current note is the last one that has started
        if (next > 0) {
            const note = noteEvents[next - 1];

            // The 32 x 16 grid covers the whole displayed image
            const cellWidth = photo.offsetWidth / IMAGE_WIDTH;
            const cellHeight = photo.offsetHeight / IMAGE_HEIGHT;

            box.style.left = (photo.offsetLeft + note.x * cellWidth) + 'px';
            box.style.top = (photo.offsetTop + note.y * cellHeight) + 'px';
            box.style.width = cellWidth + 'px';
            box.style.height = cellHeight + 'px';
            box.style.display = 'block';
        }

        animationId = requestAnimationFrame(frame);
    }

    animationId = requestAnimationFrame(frame);
}

// Stop playback
function stopMusic() {
    if (instrument) {
        instrument.stop();
    }

    cancelAnimationFrame(animationId);

    if (marker) {
        marker.style.display = 'none';
    }
}

stopBtn.addEventListener('click', stopMusic);
