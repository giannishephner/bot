# Попробуем разные варианты API
cat > src/find-15m. ts << 'EOF'
async function find15mMarkets() {
    console.log("🔍 Ищем 15-минутные рынки.. .\n");

    const endpoints = [
        // Разные варианты endpoints
        "https://gamma-api.polymarket.com/markets? limit=100&order=endDate&ascending=true&closed=false",
        "https://gamma-api.polymarket. com/markets?limit=100&_sort=created_at: desc",
        "https://gamma-api.polymarket.com/events?limit=100&active=true&closed=false",
        "https://gamma-api.polymarket.com/markets?tag=crypto&limit=100",
        "https://gamma-api.polymarket.com/events?tag=crypto&limit=100",
        
        // Strapi endpoints (старый API)
        "https://strapi-matic.poly.market/markets?_limit=50&active=true",
        
        // Попробуем с другими параметрами
        "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume&limit=50",
        "https://gamma-api.polymarket.com/events?active=true&closed=false&_limit=50",
    ];

    for (const url of endpoints) {
        console.log(`\n📡 ${url}`);
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console. log(`   ❌ HTTP ${res.status}`);
                continue;
            }
            const data = await res.json() as any[];
            
            if (! Array.isArray(data)) {
                console.log(`   Не массив:  ${JSON.stringify(data).substring(0, 100)}`);
                continue;
            }

            console.log(`   ✅ Результатов: ${data. length}`);
            
            // Показываем первые 3
            data.slice(0, 3).forEach((item:  any, i: number) => {
                const title = item.question || item.title || item.slug || "N/A";
                const date = item.endDate || item.created_at || "";
                console.log(`   ${i+1}. ${title. substring(0, 50)}... (${date})`);
            });

            // Ищем что-то связанное с 15min/btc/updown
            const relevant = data.filter((m: any) => {
                const text = JSON.stringify(m).toLowerCase();
                return text.includes("15") || text.includes("minute") || 
                       text. includes("updown") || text.includes("up-down");
            });

            if (relevant.length > 0) {
                console.log(`\n   🎯 Найдено ${relevant.length} релевантных! `);
                relevant.slice(0, 2).forEach((m: any) => {
                    console.log(`   - ${m.question || m.title || m.slug}`);
                    console.log(`     slug: ${m.slug}`);
                });
            }

        } catch (e:  any) {
            console.log(`   ❌ Error:  ${e.message}`);
        }
    }

    // Проверим что есть на странице polymarket. com/crypto/15M
    console.log("\n\n🌐 Пробуем получить данные как браузер.. .");
    try {
        const res = await fetch("https://polymarket.com/api/markets?category=crypto", {
            headers:  {
                "User-Agent": "Mozilla/5.0",
                "Accept":  "application/json"
            }
        });
        console.log(`   Status: ${res.status}`);
        if (res.ok) {
            const text = await res.text();
            console. log(`   Response: ${text.substring(0, 300)}`);
        }
    } catch (e:  any) {
        console.log(`   ❌ ${e.message}`);
    }
}

find15mMarkets();
EOF

npx tsc src/find-15m.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020
node dist/find-15m.js
