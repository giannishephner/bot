cat > src/check-15m. ts << 'EOF'
async function check15m() {
    console.log("🔍 Ищем 15-минутные рынки...\n");

    const res = await fetch(
        "https://gamma-api.polymarket.com/markets? active=true&closed=false&limit=500"
    );
    const data = await res. json() as any[];

    console. log(`Всего активных рынков:  ${data.length}\n`);

    // Ищем все crypto up/down рынки
    const updown = data.filter((m: any) => {
        const slug = (m.slug || "").toLowerCase();
        const question = (m.question || "").toLowerCase();
        return slug. includes("updown") || question.includes("up or down");
    });

    console.log(`Up/Down рынков: ${updown. length}\n`);

    // Группируем по типу (5m, 15m, 1h и т.д.)
    const by5m = updown.filter((m: any) => m.slug?.includes("-5m-"));
    const by15m = updown.filter((m: any) => m.slug?.includes("-15m-"));
    const by1h = updown.filter((m: any) => m.slug?.includes("-1h-"));

    console.log(`5-минутных:  ${by5m. length}`);
    console.log(`15-минутных: ${by15m.length}`);
    console.log(`1-часовых: ${by1h.length}\n`);

    // Показываем 15-минутные
    console.log("=== 15-МИНУТНЫЕ РЫНКИ ===\n");
    
    const now = Date.now();
    const active15m = by15m
        .filter((m: any) => new Date(m.endDate).getTime() > now)
        .sort((a:  any, b: any) => 
            new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
        );

    active15m.slice(0, 20).forEach((m: any, i: number) => {
        const timeLeft = Math.round((new Date(m.endDate).getTime() - now) / 1000 / 60);
        
        let prices = [0. 5, 0.5];
        try {
            prices = JSON.parse(m. outcomePrices || "[]").map((p: string) => parseFloat(p));
        } catch {}

        console.log(`${i+1}. ${m.question}`);
        console.log(`   slug: ${m.slug}`);
        console.log(`   До истечения: ${timeLeft} мин`);
        console.log(`   UP:  ${(prices[0] * 100).toFixed(1)}% | DOWN: ${(prices[1] * 100).toFixed(1)}%`);
        console.log(`   volume24hr: ${m.volume24hr || 0}`);
        console.log();
    });

    // Группируем по активу
    console.log("\n=== ПО АКТИВАМ ===\n");
    
    const assets = ["btc", "eth", "sol", "xrp"];
    for (const asset of assets) {
        const assetMarkets = active15m.filter((m: any) => 
            m.slug?.toLowerCase().includes(`${asset}-updown-15m`)
        );
        console.log(`${asset. toUpperCase()}: ${assetMarkets.length} активных 15m рынков`);
        
        if (assetMarkets.length > 0) {
            const next = assetMarkets[0];
            const timeLeft = Math.round((new Date(next.endDate).getTime() - now) / 1000 / 60);
            console.log(`   Ближайший:  ${next.question}`);
            console. log(`   До истечения: ${timeLeft} мин`);
        }
        console. log();
    }
}

check15m();
EOF

npx tsc src/check-15m.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020
node dist/check-15m.js
