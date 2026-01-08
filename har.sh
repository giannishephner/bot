# Скачаем и посмотрим HAR файл
cat > src/parse-har.ts << 'EOF'
import * as fs from "fs";

async function parseHar() {
    // Читаем HAR файл
    const harPath = process.argv[2] || "polymarket. com_Archive [26-01-08 19-47-52].har";
    
    let harData:  any;
    try {
        const content = fs.readFileSync(harPath, "utf-8");
        harData = JSON.parse(content);
    } catch (e) {
        console.log("Не удалось прочитать HAR файл.   Укажите путь:  node dist/parse-har. js <path>");
        process.exit(1);
    }

    console.log("🔍 Анализируем HAR файл.. .\n");

    const entries = harData.log?. entries || [];
    console.log(`Всего запросов: ${entries.length}\n`);

    // Ищем API запросы
    const apiRequests = entries. filter((e: any) => {
        const url = e.request?. url || "";
        return url.includes("gamma-api") || 
               url.includes("clob. polymarket") ||
               url.includes("/api/") ||
               url. includes("strapi");
    });

    console.log(`API запросов:  ${apiRequests.  length}\n`);

    console.log("=== API ENDPOINTS ===\n");

    const uniqueUrls = new Set<string>();
    
    apiRequests. forEach((e:   any) => {
        const url = e.request?.url || "";
        // Убираем query params для группировки
        const baseUrl = url.split("?")[0];
        uniqueUrls.add(baseUrl);
    });

    uniqueUrls.forEach(url => {
        console.log(url);
    });

    // Ищем запросы связанные с crypto/15m/updown
    console. log("\n=== ЗАПРОСЫ С CRYPTO/15M/UPDOWN ===\n");

    const cryptoRequests = entries.filter((e: any) => {
        const url = (e.request?.url || "").toLowerCase();
        const response = (e.response?.content?. text || "").toLowerCase();
        return url. includes("15m") || 
               url.includes("updown") ||
               url.includes("crypto") ||
               response.includes("15m") ||
               response.includes("updown");
    });

    console.log(`Найдено: ${cryptoRequests.length}\n`);

    cryptoRequests. slice(0, 10).forEach((e: any, i: number) => {
        console.log(`${i+1}. ${e.request?.method} ${e.request?. url}`);
        
        // Показываем часть ответа
        const responseText = e.response?.content?.text || "";
        if (responseText && responseText.length > 0) {
            console.log(`   Response (первые 300 символов):`);
            console.log(`   ${responseText.substring(0, 300)}...`);
        }
        console.log();
    });

    // Ищем все уникальные домены
    console. log("\n=== ВСЕ ДОМЕНЫ ===\n");
    
    const domains = new Set<string>();
    entries.forEach((e: any) => {
        try {
            const url = new URL(e.request?.url || "");
            domains.add(url. hostname);
        } catch {}
    });

    domains.forEach(d => console.log(d));
}

parseHar();
EOF

npx tsc src/parse-har.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020

# Запустите с путём к вашему HAR файлу: 
node dist/parse-har.js "polymarket.com_Archive [26-01-08 19-47-52].har"
