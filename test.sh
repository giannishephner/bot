cat > src/test-api.ts << 'EOF'
async function testApis() {
    console.log("🔍 Тестируем Polymarket APIs...\n");

    // 1. Gamma API - Markets
    console.log("1. Gamma API /markets:");
    try {
        const res = await fetch("https://gamma-api.polymarket.com/markets? closed=false&active=true&limit=50");
        const data = await res.json() as any[];
        console.log(`   Найдено рынков: ${data.length}`);
        
        // Ищем BTC/crypto рынки
        const cryptoMarkets = data.filter((m: any) => {
            const q = (m.question || "").toLowerCase();
            const s = (m.slug || "").toLowerCase();
            return q. includes("btc") || q.includes("bitcoin") || 
                   q. includes("crypto") || s.includes("btc") ||
                   q.includes("15") || s.includes("15m");
        });
        
        console.log(`   Крипто/BTC рынков: ${cryptoMarkets.length}\n`);
        
        cryptoMarkets.slice(0, 10).forEach((m: any, i: number) => {
            console. log(`   ${i+1}. ${m.question}`);
            console.log(`      slug: ${m.slug}`);
            console.log(`      active: ${m.active}, closed: ${m. closed}`);
            console.log(`      outcomes: ${JSON.stringify(m. outcomes)}`);
            console.log(`      prices: ${JSON.stringify(m.outcomePrices)}`);
            console.log(`      tokens: ${JSON.stringify(m.clobTokenIds)}`);
            console.log();
        });

        // Показать все активные рынки
        console.log("\n   Все активные рынки:");
        data.slice(0, 20).forEach((m: any, i: number) => {
            console.log(`   ${i+1}. ${m.question?. substring(0, 60)}...`);
        });

    } catch (e:  any) {
        console.log(`   ❌ Ошибка:  ${e.message}`);
    }

    // 2. Gamma API - Events  
    console.log("\n\n2. Gamma API /events:");
    try {
        const res = await fetch("https://gamma-api.polymarket. com/events?closed=false&active=true&limit=20");
        const data = await res.json() as any[];
        console.log(`   Найдено событий: ${data.length}`);
        
        data.slice(0, 10).forEach((e: any, i: number) => {
            console.log(`   ${i+1}. ${e.title || e.slug}`);
            console. log(`      markets: ${e.markets?. length || 0}`);
        });
    } catch (e:  any) {
        console.log(`   ❌ Ошибка:  ${e.message}`);
    }

    // 3. Ищем 15-минутные рынки по slug
    console.log("\n\n3. Поиск 15m рынков:");
    try {
        // Попробуем разные запросы
        const queries = [
            "https://gamma-api.polymarket.com/markets?slug_contains=15m",
            "https://gamma-api.polymarket.com/markets?slug_contains=btc",
            "https://gamma-api.polymarket.com/events?slug_contains=btc-updown",
        ];

        for (const url of queries) {
            console.log(`\n   ${url}:`);
            const res = await fetch(url);
            const data = await res. json();
            if (Array.isArray(data)) {
                console.log(`   Результатов: ${data. length}`);
                data.slice(0, 3).forEach((m: any) => {
                    console.log(`   - ${m.question || m.title || m.slug}`);
                });
            } else {
                console.log(`   Ответ: ${JSON.stringify(data).substring(0, 200)}`);
            }
        }
    } catch (e: any) {
        console.log(`   ❌ Ошибка: ${e.message}`);
    }
}

testApis();
EOF

npx tsc src/test-api. ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020
node dist/test-api.js
