cat > src/check-wallet.ts << 'EOF'
import { ethers } from "ethers";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "../.env") });

async function checkWallet() {
    const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
    const address = process.env.FUNDER_ADDRESS || "";
    
    console.log(`\n🔍 Проверяем кошелёк:  ${address}\n`);

    // MATIC баланс
    const maticBalance = await provider.getBalance(address);
    console.log(`MATIC:  ${ethers.utils.formatEther(maticBalance)}`);

    // USDC баланс (Polygon USDC)
    const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
    const usdc = new ethers. Contract(usdcAddress, usdcAbi, provider);
    
    const usdcBalance = await usdc.balanceOf(address);
    console.log(`USDC: ${ethers.utils.formatUnits(usdcBalance, 6)}`);

    // USDC. e (bridged USDC)
    const usdceAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const usdce = new ethers. Contract(usdceAddress, usdcAbi, provider);
    
    try {
        const usdceBalance = await usdce.balanceOf(address);
        console.log(`USDC.e: ${ethers.utils.formatUnits(usdceBalance, 6)}`);
    } catch {}

    console.log(`\n📋 Что нужно для торговли:`);
    console.log(`   - USDC на Polygon (минимум $5-10 для тестов)`);
    console.log(`   - MATIC для газа (минимум 0.1 MATIC)`);
    console.log(`   - Активированный аккаунт на polymarket.com`);
}

checkWallet();
EOF

npx tsc src/check-wallet.ts --outDir dist --esModuleInterop --skipLibCheck --module CommonJS --target ES2020
node dist/check-wallet.js
