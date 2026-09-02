const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Ensure target directory exists
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Generate a valid 1x1 dark gray PNG buffer
function createMinimalPng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk (1x1 pixel, 8-bit RGBA)
  const ihdrData = Buffer.from([
    0, 0, 0, 1, // width: 1
    0, 0, 0, 1, // height: 1
    8,          // bit depth: 8
    6,          // color type: RGBA
    0, 0, 0     // compression, filter, interlace
  ]);
  const ihdrChunk = createChunk('IHDR', ihdrData);

  // IDAT chunk (raw pixel data: dark slate color #2C3E50)
  const rawPixelData = Buffer.from([0, 44, 62, 80, 255]); // filter byte + RGBA
  const compressedData = zlib.deflateSync(rawPixelData);
  const idatChunk = createChunk('IDAT', compressedData);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  
  const crc32 = calculateCrc32(Buffer.concat([typeBuffer, data]));
  crcBuffer.writeUInt32BE(crc32, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function calculateCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Write the default-logo.png file
const logoPath = path.join(uploadDir, 'default-logo.png');
fs.writeFileSync(logoPath, createMinimalPng());
console.log(`✓ Directory created: ${uploadDir}`);
console.log(`✓ Placeholder logo created: ${logoPath}`);