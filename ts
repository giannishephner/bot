npx tsc src/check-markets.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020

node dist/check-markets.js
