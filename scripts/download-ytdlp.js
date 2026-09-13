// npm install 시 자동으로 실행되어 yt-dlp 실행파일을 받아옵니다.
// GitHub API를 거치지 않고 "latest" 릴리즈 다이렉트 링크를 사용해서
// API 요청 제한(rate limit) 문제를 피합니다.
const https = require('https');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function download(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('리다이렉트가 너무 많습니다'));
      return;
    }
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve(download(res.headers.location, dest, redirectCount + 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`다운로드 실패 (HTTP ${res.statusCode})`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  try {
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log('yt-dlp 다운로드 중...');
    await download(DOWNLOAD_URL, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    console.log('✅ yt-dlp 다운로드 완료:', BIN_PATH);
  } catch (error) {
    // 설치 자체를 실패시키지 않습니다 (음악 기능만 안 되고 나머지는 정상 작동하도록).
    console.error('⚠️ yt-dlp 다운로드 실패 (음악 기능이 작동하지 않을 수 있습니다):', error.message);
  }
})();
