npx tsc src/check-markets.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020

node dist/check-markets.js

sed -i 's/const markets:   any\[\] = await response.json();/const markets = await response.json() as any[];/g' src/arbitrage-bot.ts

sed -i 's/const allMarkets:  any\[\] = await response.json();/const allMarkets = await response.json() as any[];/g' src/arbitrage-bot.ts


0x200d883435e29fcf89af1bf6d7b54252fc8dfa2a250452358a19fcc33bbbb5c3

0x98cfA021C64e56956cF38d21fEdc3432f92066Dd
