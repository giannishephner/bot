npx tsc src/check-markets.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020

node dist/check-markets.js

sed -i 's/const markets:   any\[\] = await response.json();/const markets = await response.json() as any[];/g' src/arbitrage-bot.ts

sed -i 's/const allMarkets:  any\[\] = await response.json();/const allMarkets = await response.json() as any[];/g' src/arbitrage-bot.ts
