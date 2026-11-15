const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const photo = document.getElementById('photo');

const cameraBtn = document.getElementById('cameraBtn');
const onBtn = document.getElementById('onBtn');
const generateBtn = document.getElementById('generateMusicBtn');
const stopBtn = document.getElementById('stopMusicBtn');

let stream;
let audioContext;
let activeOscillators = [];

// Holds the edge-detected image (this is what's displayed and sonified)
const edgeCanvas = document.createElement('canvas');

// MUSICAL SETTINGS
const SCALE = [0, 2, 4, 7, 9]; // C major pentatonic
const IMAGE_WIDTH = 32;
const IMAGE_HEIGHT = 16;
const NOTE_DURATION = 0.12;
const BPM = 120;

// EDGE KERNEL (Sobel, horizontal edges)
// Responds to changes in brightness between rows, i.e. horizontal edges.
// For vertical edges instead, swap to: [-1, 0, 1, -2, 0, 2, -1, 0, 1]
const EDGE_KERNEL = [
    -1, -2, -1,
     0,  0,  0,
     1,  2,  1
];

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

// Apply the edge kernel to the R values of an RGBA ImageData.
// Returns a new ImageData where R = G = B = edge strength, A = 255.
function applyEdgeKernel(imageData) {
    const { width, height, data } = imageData;
    const output = new ImageData(width, height);
    const out = output.data;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {

            let sum = 0;

            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {

                    // Clamp coordinates at the image borders
                    const px = Math.min(width - 1, Math.max(0, x + kx));
                    const py = Math.min(height - 1, Math.max(0, y + ky));

                    // R value of RGBA array
                    const red = data[(py * width + px) * 4];

                    const weight = EDGE_KERNEL[(ky + 1) * 3 + (kx + 1)];

                    sum += red * weight;
                }
            }

            // Edge strength, clamped to 0-255
            const edge = Math.min(255, Math.abs(sum));

            const i = (y * width + x) * 4;
            out[i] = edge;
            out[i + 1] = edge;
            out[i + 2] = edge;
            out[i + 3] = 255;
        }
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

    for (let y = 0; y < IMAGE_HEIGHT; y++) {

        for (let x = 0; x < IMAGE_WIDTH; x++) {

            const index = (y * IMAGE_WIDTH + x) * 4;

            // Edge image is greyscale, so R holds the edge strength
            const edge = pixels[index];
            const alpha = pixels[index + 3];

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

            const frequency = midiToFrequency(midiNote);

            // The edge image has no colour (hue is meaningless),
            // so strong edges get a brighter timbre instead
            const waveform = edge > 64 ? 'triangle' : 'sine';

            // Create oscillator
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();

            oscillator.type = waveform;
            oscillator.frequency.value = frequency;

            // Note timing
            const noteTime =
                startTime + noteIndex * NOTE_DURATION;

            // Fade notes in and out
            gain.gain.setValueAtTime(0.0001, noteTime);
            gain.gain.linearRampToValueAtTime(
                0.12,
                noteTime + 0.015
            );

            gain.gain.exponentialRampToValueAtTime(
                0.0001,
                noteTime + NOTE_DURATION * 0.9
            );

            oscillator.connect(gain);
            gain.connect(audioContext.destination);

            oscillator.start(noteTime);
            oscillator.stop(noteTime + NOTE_DURATION);

            activeOscillators.push(oscillator);

            noteIndex++;
        }
    }

    console.log(`Generated ${noteIndex} notes!`);
});

// Stop playback
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