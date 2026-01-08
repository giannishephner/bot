cat > src/check-markets.ts << 'EOF'
import { ClobClient, Chain } from "@polymarket/clob-client";

async function checkMarkets() {
    const client = new ClobClient("https://clob.polymarket.com", 137 as Chain);
    
    console.log("🔍 Ищем рынки на Polymarket.. .\n");
    
    try {
        const response = await client.getMarkets();
        const markets:  any[] = (response as any).data || [];
        
        console.log(`Найдено рынков: ${markets. length}\n`);
        
        // Ищем рынки связанные с Bitcoin/BTC/Crypto
        const cryptoMarkets = markets. filter((m: any) => {
            const q = (m.question || "").toLowerCase();
            return q. includes("bitcoin") || 
                   q. includes("btc") || 
                   q.includes("crypto") ||
                   q. includes("price");
        });
        
        console.log(`\n📊 Крипто-рынки (${cryptoMarkets. length}):\n`);
        
        cryptoMarkets.forEach((m:  any, i: number) => {
            console.log(`${i + 1}.  ${m.question}`);
            console.log(`   Condition ID: ${m.condition_id}`);
            console.log(`   Tokens: ${m.tokens?. length || 0}`);
            if (m.tokens) {
                m.tokens.forEach((t: any) => {
                    console.log(`     - ${t.outcome}:  ${t.token_id?. substring(0, 20)}...`);
                });
            }
            console.log();
        });
        
        // Показать первые 10 любых рынков
        console.log(`\n📋 Первые 10 рынков:\n`);
        markets.slice(0, 10).forEach((m: any, i: number) => {
            console.log(`${i + 1}. ${m.question?. substring(0, 70)}...`);
        });
        
    } catch (error) {
        console.error("Ошибка:", error);
    }
}

checkMarkets();
EOF
