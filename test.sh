cat > src/find-btc-15m.ts << 'EOF'
async function findBtc15m() {
    console.log("🔍 Ищем BTC 15-минутные рынки.. .\n");

    const res = await fetch(
        "https://gamma-api.polymarket.com/markets? active=true&closed=false&order=volume&limit=200"
    );
    const markets = await res.json() as any[];

    console.log(`Всего активных рынков:  ${markets.length}\n`);

    // Фильтруем крипто up/down рынки
    const cryptoUpDown = markets. filter((m: any) => {
        const slug = (m.slug || "").toLowerCase();
        const question = (m.question || "").toLowerCase();
        return slug. includes("updown") || slug.includes("up-down") ||
               question.includes("up or down");
    });

    console.log(`Крипто Up/Down рынков: ${cryptoUpDown.length}\n`);

    // Группируем по типу (BTC, ETH, SOL)
    const btcMarkets = cryptoUpDown.filter((m: any) => 
        m.slug?. includes("btc") || m.question?.toLowerCase().includes("bitcoin")
    );
    const ethMarkets = cryptoUpDown.filter((m: any) => 
        m.slug?.includes("eth") || m.question?.toLowerCase().includes("ethereum")
    );
    const solMarkets = cryptoUpDown.filter((m: any) => 
        m. slug?.includes("sol") || m.question?.toLowerCase().includes("solana")
    );

    console.log(`BTC рынков: ${btcMarkets.length}`);
    console.log(`ETH рынков: ${ethMarkets.length}`);
    console.log(`SOL рынков: ${solMarkets.length}\n`);

    // Показываем BTC рынки
    console.log("=== BTC Up/Down рынки ===\n");
    btcMarkets.slice(0, 10).forEach((m: any, i: number) => {
        console. log(`${i+1}. ${m.question}`);
        console.log(`   slug: ${m.slug}`);
        console.log(`   endDate: ${m.endDate}`);
        console.log(`   outcomes: ${m.outcomes}`);
        console.log(`   prices: ${m.outcomePrices}`);
        console.log(`   tokenIds: ${m.clobTokenIds}`);
        console.log();
    });

    // Если нет BTC, показываем ETH
    if (btcMarkets.length === 0) {
        console.log("❌ BTC рынки не найдены.  Показываем ETH:\n");
        ethMarkets.slice(0, 5).forEach((m: any, i: number) => {
            console.log(`${i+1}.  ${m.question}`);
            console. log(`   slug: ${m.slug}`);
            console. log(`   endDate: ${m.endDate}`);
            console.log(`   prices: ${m.outcomePrices}`);
            console. log(`   tokenIds: ${m.clobTokenIds}`);
            console.log();
        });
    }

    // Показываем ближайший рынок к истечению
    const now = Date.now();
    const upcoming = cryptoUpDown
        .filter((m: any) => new Date(m.endDate).getTime() > now)
        .sort((a: any, b: any) => 
            new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
        );

    if (upcoming.length > 0) {
        console.log("\n=== Ближайший активный рынок ===\n");
        const m = upcoming[0];
        const timeLeft = Math.round((new Date(m.endDate).getTime() - now) / 1000 / 60);
        console.log(`${m.question}`);
        console.log(`До истечения: ${timeLeft} минут`);
        console.log(`slug: ${m.slug}`);
        console.log(`outcomes: ${m.outcomes}`);
        console.log(`prices: ${m.outcomePrices}`);
        console.log(`tokenIds: ${m.clobTokenIds}`);
        console.log(`\nПолные данные:`);
        console.log(JSON.stringify(m, null, 2));
    }
}

findBtc15m();
EOF

npx tsc src/find-btc-15m.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020
node dist/find-btc-15m. js
