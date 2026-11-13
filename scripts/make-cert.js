// Creates a self-signed HTTPS certificate covering localhost and this machine's LAN IPs.
// Phones/tablets require HTTPS before a web page may use the microphone.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(dir, { recursive: true });
const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4').map((i) => i.address);
const san = ['DNS:localhost', ...ips.map((ip) => 'IP:' + ip)].join(',');
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=Production Comms', '-addext', 'subjectAltName=' + san,
  ], { stdio: 'inherit' });
  console.log('\nCertificate created for: ' + san.replace(/DNS:|IP:/g, ''));
  console.log('Restart the server. Each device will show a security warning once; accept it to continue.');
} catch (e) {
  console.error('Could not run openssl. Install OpenSSL, or put your own key.pem and cert.pem in ./certs');
  process.exit(1);
}
