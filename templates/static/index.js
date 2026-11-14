const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const photo = document.getElementById('photo');
const cameraBtn = document.getElementById('cameraBtn');
const onBtn = document.getElementById('onBtn');

let stream;
onBtn.addEventListener('click', async() => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    console.error("Camera access denied!", err);
  }
});

cameraBtn.addEventListener('click', () => {
    const context = canvas.getContext('2d');

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;


    context.drawImage(video, 0, 0);

    const dataURL = canvas.toDataURL('image/png');
    photo.src = dataURL;

});