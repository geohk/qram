/*!
 * Copyright (c) 2019 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const {
  QRCode,
  'base64url-universal': base64url,
  jsQR,
  qram: {Decoder, Encoder, getImageData}
} = window;

document.addEventListener('DOMContentLoaded', () => {
  _on('present', 'click', present);
  _on('receive', 'click', receive);
  _on('camera', 'click', toggleCamera);
  _on('customData', 'click', setCustomData);
  _clearProgress();
  _hide('video');
});

const state = {
  decoder: null,
  enableCamera: false,
  runEncoder: false,
  size: 1024,
  customData: null
};

function setCustomData() {
  const textInput = document.getElementById('customDataInput').value;
  if (!textInput.trim()) {
    alert('Please enter some text to encode');
    return;
  }
  
  const enc = new TextEncoder();
  state.customData = enc.encode(textInput);
  
  // Update the size display to match the actual data size
  document.getElementById('size').value = state.customData.length;
  
  console.log(`Custom data set: ${state.customData.length} bytes`);
  alert(`Custom data set: ${state.customData.length} bytes ready to present`);
}

async function toggleCamera() {
  const video = document.getElementById('video');

  if(state.enableCamera) {
    console.log('Camera turned off');
    state.enableCamera = false;
    video.srcObject = null;
    return;
  }

  if(state.runEncoder) {
    // turn off presentation
    present();
  }

  console.log('Camera turned on');
  _hide('canvas');
  _hide('progress');
  _show('video');
  _show('progress');

  const constraints = {
    audio: false,
    video: {
      width: {min: 500},
      height: {min: 500},
      facingMode: 'environment'
    }
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
  } catch(e) {
    console.error('Failed to setup camera', e);
  }

  state.enableCamera = true;
}

async function present() {
  if(state.runEncoder) {
    console.log('Presentation stopped');
    state.runEncoder = false;
    return;
  }

  // turn off camera
  if(state.enableCamera) {
    toggleCamera();
  }

  _hide('video');
  _hide('progress');
  _show('canvas');
  _show('presenting');

  const size = parseInt(document.getElementById('size').value, 10) || 1024;
  const blockSize = parseInt(
    document.getElementById('block-size').value, 10) || 400;
  let fps = document.getElementById('fps').value;
  const resistance = document.getElementById('resistance').value;

  if(fps !== 'auto') {
    fps = parseInt(fps, 10) || 15;
  } else {
    // rough decent estimate: do `blockCount` frames per second
    fps = Math.min(30, Math.ceil(size / blockSize));
  }

  let sizeMsg;
  if(size < 1024) {
    sizeMsg = `${size} bytes`;
  } else {
    sizeMsg = `${Math.floor(size / 1024)} kiB`;
  }
  const presentMsg =
    `Presenting ${sizeMsg} @ ${fps} frames/second, block size is ` +
    `${blockSize} bytes...`;
  document.getElementById('presenting').innerHTML = presentMsg;
  console.log(presentMsg);

  state.runEncoder = true;

  // Use custom data if available, otherwise generate random data
  let data;
  if (state.customData) {
    data = state.customData;
    console.log('Using custom data for presentation');
  } else {
    // Generate random data of specified size
    data = new Uint8Array(size);
    crypto.getRandomValues(data);
    console.log('Using random data for presentation');
  }

  let version;
  const maxBlocksPerPacket = 50;
  // const maxPacketSize = Encoder.getMaxPacketSize({
  //   size: data.length,
  //   blockSize,
  //   maxBlocksPerPacket
  // });
  // console.log('maxPacketSize', maxPacketSize);

  if(blockSize <= 10) {
    if(resistance === 'H') {
      version = 16;
    } else {
      version = 14;
    }
  } else if(blockSize <= 50) {
    if(resistance === 'H') {
      version = 18;
    } else {
      version = 16;
    }
  } else if(blockSize <= 100) {
    if(resistance === 'H') {
      version = 19;
    } else {
      version = 17;
    }
  } else if(blockSize <= 200) {
    if(resistance === 'H') {
      version = 22;
    } else {
      version = 19;
    }
  } else if(blockSize <= 300) {
    if(resistance === 'H') {
      version = 25;
    } else {
      version = 22;
    }
  } else if(blockSize <= 400) {
    if(resistance === 'H') {
      version = 29;
    } else {
      version = 25;
    }
  }

  const encoder = new Encoder({data, blockSize, maxBlocksPerPacket});
  const timer = encoder.createTimer({fps});
  const canvas = document.getElementById('canvas');
  const stream = await encoder.createReadableStream();
  const reader = stream.getReader();
  timer.start();
  while(state.runEncoder) {
    const {value: packet} = await reader.read();
    const text = base64url.encode(packet.data);
    await QRCode.toCanvas(canvas, text, {
      version,
      mode: 'alphanumeric',
      errorCorrectionLevel: resistance
    });
    await timer.nextFrame();
  }
}

async function receive() {
  if(state.decoder) {
    console.log('Receive canceled');
    state.decoder.cancel();
    state.decoder = null;
    return;
  }

  _clearProgress();
  _hide('presenting');
  _show('progress');

  let source;
  if(state.enableCamera) {
    console.log('Decoding from camera...');
    // get a video element to read images of qr-codes from
    source = document.getElementById('video');
  } else if(state.runEncoder) {
    console.log('Decoding from canvas directly...');
    // get canvas element to read images of qr-codes from
    source = document.getElementById('canvas');
  } else {
    console.error('Receive aborted, not using camera or presenting locally.');
    return;
  }

  console.log('Scanning...');
  const decoder = state.decoder = new Decoder();

  // use `requestAnimationFrame` so that scanning will not happen unless the
  // user has focused the window/tab displaying the qr-code stream
  requestAnimationFrame(() => setTimeout(enqueue, 0));

  function enqueue() {
    // use qram helper to get image data
    const imageData = getImageData({source});

    // use qr-code reader of choice to get Uint8Array or Uint8ClampedArray
    // representing the packet
    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert'
    });
    if(!result) {
      // no QR code found, try again on the next frame
      return requestAnimationFrame(() => setTimeout(enqueue, 0));
    }

    // enqueue the packet data for decoding, ignoring any non-cancel errors
    // and rescheduling until done or aborted
    const {data: text} = result;
    const data = base64url.decode(text);
    console.log(`Scanned ${data.length} bytes, parsing...`);
    decoder.enqueue(data)
      .then(progress => {
        if(!progress.done) {
          _updateProgress({progress});
          setTimeout(enqueue, 0);
        }
      })
      .catch(e => {
        if(e.name === 'AbortError') {
          return;
        }
        console.error(e);
        setTimeout(enqueue, 0);
      });
  }

  try {
    // result found
    const start = Date.now();
    const progress = await decoder.decode();
    _updateProgress({progress});
    const time = ((Date.now() - start) / 1000).toFixed(3);
    const {data} = progress;
    // console.log('decoded data', data);
    _finish({data, time});
  } catch(e) {
    // failure to decode
    console.error(e);
  }

  state.runEncoder = false;
  state.decoder = null;
}

function _updateProgress({progress}) {
  console.log('Progress', progress);
  const {
    blocks,
    receivedPackets,
    receivedBlocks,
    totalBlocks
  } = progress;
  console.log(`Decoded ${receivedBlocks}/${totalBlocks} blocks`);
  const packetsElement = document.getElementById('packets');
  packetsElement.innerHTML = `Received ${receivedPackets} packets`;
  const blocksElement = document.getElementById('blocks');
  blocksElement.innerHTML = `Decoded ${receivedBlocks}/${totalBlocks} blocks`;
  const blocksMapElement = document.getElementById('blocksmap');
  let blocksMapHTML = '';
  // block width without margin rounded down
  const blockWidth =
    Math.floor((500 - ((totalBlocks - 1) * 1/*px*/)) / totalBlocks);
  for(let i = 0; i < totalBlocks; ++i) {
    const cl = blocks.has(i) ? 'found' : 'missing';
    blocksMapHTML +=
      `<span class="${cl}" style="width: ${blockWidth}px">&nbsp;</span>\n`;
  }
  blocksMapElement.innerHTML = blocksMapHTML;
}

function _finish({data, time}) {
  const size = (data.length / 1024).toFixed(3);
  const msg = `Decoded ${size} KiB in time ${time} seconds`;
  console.log(msg);
  
  // Display decoded info
  const element = document.getElementById('finish');
  
  // Try to decode as text for display
  let displayText;
  try {
    displayText = new TextDecoder().decode(data);
    // Limit display text length to prevent UI issues
    if (displayText.length > 1000) {
      displayText = displayText.substring(0, 1000) + '... (truncated for display)';
    }
  } catch (e) {
    displayText = '(Binary data)';
  }
  
  // Check if the content might be base64
  const isLikelyBase64 = /^[A-Za-z0-9+/=]+$/.test(displayText.trim());
  
  element.innerHTML = `
    <div>${msg}</div>
    <div style="margin-top: 10px">
      <button id="downloadText" class="btn">Download as Text</button>
      ${isLikelyBase64 ? '<button id="downloadBase64" class="btn">Decode Base64 & Download</button>' : ''}
    </div>
    <div style="margin-top: 10px; word-break: break-all; max-height: 200px; overflow-y: auto;">
      <strong>Preview:</strong> ${displayText}
    </div>
  `;
  
  // Add click handler for download button
  document.getElementById('downloadText').addEventListener('click', () => {
    downloadAsText(data);
  });
  
  // Add click handler for base64 decode button if shown
  if (isLikelyBase64) {
    document.getElementById('downloadBase64').addEventListener('click', () => {
      downloadAsBase64Decoded(displayText);
    });
  }
}

function downloadAsText(data) {
  try {
    // Convert the data to text
    const text = new TextDecoder().decode(data);
    
    // Check if the content looks like base64
    const isLikelyBase64 = /^[A-Za-z0-9+/=]+$/.test(text.trim());
    
    if (isLikelyBase64) {
      // If it looks like base64, try to decode it first
      try {
        // Clean the string and add padding if needed
        let base64String = text.trim();
        while (base64String.length % 4 !== 0) {
          base64String += '=';
        }
        
        // Try to decode the base64 string
        let binaryString;
        try {
          // Try standard base64 first
          binaryString = atob(base64String);
        } catch (e) {
          // If standard base64 fails, try base64url format
          const base64 = base64String
            .replace(/-/g, '+')
            .replace(/_/g, '/');
          binaryString = atob(base64);
        }
        
        // Convert binary string to array buffer
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Try to convert to text
        const decodedText = new TextDecoder().decode(bytes);
        
        // Create a Blob containing the decoded text
        const blob = new Blob([decodedText], { type: 'text/plain' });
        
        // Create a download link and trigger it
        const downloadLink = document.createElement('a');
        downloadLink.href = URL.createObjectURL(blob);
        downloadLink.download = 'decoded_base64.txt';
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        
        // Clean up the object URL
        setTimeout(() => {
          URL.revokeObjectURL(downloadLink.href);
        }, 1000);
        
        console.log('Base64 decoded text file download initiated');
        return; // Exit function after successful base64 decode and download
      } catch (base64Error) {
        console.warn('Content looked like base64 but failed to decode:', base64Error);
        // Continue with normal text download if base64 decoding fails
      }
    }
    
    // If not base64 or base64 decoding failed, proceed with normal text download
    const blob = new Blob([text], { type: 'text/plain' });
    
    // Create a download link and trigger it
    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = 'qram_decoded_data.txt';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    
    // Clean up the object URL
    setTimeout(() => {
      URL.revokeObjectURL(downloadLink.href);
    }, 1000);
    
    console.log('Text file download initiated');
  } catch (error) {
    console.error('Error creating text file:', error);
    alert('Failed to create text file: ' + error.message);
    
    // Fallback to binary download if text conversion fails
    downloadAsBinary(data);
  }
}

function downloadAsBase64Decoded(base64String) {
  try {
    // Clean the string (remove whitespace, etc.)
    base64String = base64String.trim();
    
    // Add padding if needed
    while (base64String.length % 4 !== 0) {
      base64String += '=';
    }
    
    // Decode the base64 string
    let binaryString;
    try {
      // Try standard base64 first
      binaryString = atob(base64String);
    } catch (e) {
      // If standard base64 fails, try base64url format
      const base64 = base64String
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      binaryString = atob(base64);
    }
    
    // Convert binary string to array buffer
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Try to determine if the decoded content is text or binary
    let isText = true;
    for (let i = 0; i < bytes.length; i++) {
      // Check if byte is outside printable ASCII range and not common control chars
      if ((bytes[i] < 32 || bytes[i] > 126) && 
          ![9, 10, 13].includes(bytes[i])) { // tab, LF, CR
        isText = false;
        break;
      }
    }
    
    if (isText) {
      // It's likely text, so decode and download as text
      const text = new TextDecoder().decode(bytes);
      const blob = new Blob([text], { type: 'text/plain' });
      const downloadLink = document.createElement('a');
      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.download = 'base64_decoded.txt';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
    } else {
      // It's likely binary, download as binary
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const downloadLink = document.createElement('a');
      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.download = 'base64_decoded.bin';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
    }
    
    // Clean up the object URL
    setTimeout(() => {
      URL.revokeObjectURL(downloadLink.href);
    }, 1000);
    
    console.log('Base64 decoded file download initiated');
  } catch (error) {
    console.error('Error decoding base64:', error);
    alert('Failed to decode base64: ' + error.message);
  }
}

function downloadAsBinary(data) {
  try {
    // Create a Blob containing the binary data
    const blob = new Blob([data], { type: 'application/octet-stream' });
    
    // Create a download link and trigger it
    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = 'qram_decoded_data.bin';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    
    // Clean up the object URL
    setTimeout(() => {
      URL.revokeObjectURL(downloadLink.href);
    }, 1000);
    
    console.log('Binary file download initiated');
  } catch (error) {
    console.error('Error creating binary file:', error);
    alert('Failed to download file: ' + error.message);
  }
}

function _clearProgress() {
  const packets = document.getElementById('packets');
  packets.innerHTML = 'No packets received yet';
  const blocks = document.getElementById('blocks');
  blocks.innerHTML = 'No blocks decoded yet';
  const finish = document.getElementById('finish');
  finish.innerHTML = '';
}

function _on(id, event, listener) {
  const element = document.getElementById(id);
  element.addEventListener(event, listener);
}

function _show(id) {
  document.getElementById(id).style.display = 'block';
}

function _hide(id) {
  document.getElementById(id).style.display = 'none';
}
