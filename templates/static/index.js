
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

// MUSICAL SETTINGS
const SCALE = [0, 2, 4, 7, 9]; // C major pentatonic
const IMAGE_WIDTH = 32;
const IMAGE_HEIGHT = 16;
const NOTE_DURATION = 0.12;
const BPM = 120;

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

    photo.src = canvas.toDataURL('image/png');

    generateBtn.disabled = false;
});

// Generate music from photograph
generateBtn.addEventListener('click', async () => {

    // Stop previous composition
    stopMusic();

    // Create audio context
    if (!audioContext) {
        audioContext = new AudioContext();
    }

    await audioContext.resume();

    // Resize image to 32 x 16
    const smallCanvas = document.createElement('canvas');

    smallCanvas.width = IMAGE_WIDTH;
    smallCanvas.height = IMAGE_HEIGHT;

    const smallContext = smallCanvas.getContext('2d');

    smallContext.drawImage(
        canvas,
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

            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            const alpha = pixels[index + 3];

            // Ignore transparent pixels
            if (alpha === 0) continue;

            // Calculate brightness
            const brightness =
                (red * 0.299 + green * 0.587 + blue * 0.114);

            // Convert brightness into a musical scale degree
            const brightnessDegree = Math.round(
                (brightness / 255) * 14
            );

            // Vertical position changes octave
            const verticalDegree = Math.round(
                (1 - y / (IMAGE_HEIGHT - 1)) * 5
            );

            const midiNote = getScaleNote(
                brightnessDegree + verticalDegree
            );

            const frequency = midiToFrequency(midiNote);

            // Colour influences instrument timbre
            const hue = Math.atan2(
                Math.sqrt(3) * (green - blue),
                2 * red - green - blue
            );

            const waveform = hue > 0 ? 'triangle' : 'sine';

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
