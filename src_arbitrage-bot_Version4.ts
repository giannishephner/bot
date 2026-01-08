/**
 * Polymarket Crypto Up/Down Arbitrage Bot
 * Работает с 5-минутными BTC/ETH/SOL рынками
 */

import { ClobClient, Side, OrderType, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import WebSocket from "ws";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "../.env") });

// ============== КОНФИГУРАЦИЯ ==============

interface BotConfig {
    polymarketHost: string;
    gammaApiHost: string;
    chainId: Chain;
    privateKey: string;
    funderAddress: string;
    signatureType: 0 | 1;
    minEdgePercent: number;
    betSizeUsdc: number;
    momentumWindowSeconds: number;
    momentumThresholdPercent: number;
    cooldownSeconds: number;
    asset: "BTC" | "ETH" | "SOL"; // Какой актив торгуем
}

const botConfig: BotConfig = {
    polymarketHost: "https://clob.polymarket. com",
    gammaApiHost: "https://gamma-api.polymarket. com",
    chainId: 137 as Chain,
    privateKey: process. env.PRIVATE_KEY || "",
    funderAddress: process.env. FUNDER_ADDRESS || "",
    signatureType: 1,
    minEdgePercent: 5. 0,
    betSizeUsdc:  50,
    momentumWindowSeconds: 30,
    momentumThresholdPercent: 0.15,
    cooldownSeconds: 60,
    asset:  "BTC", // Торгуем Bitcoin
};

// ============== BINANCE PRICE FEED ==============

interface PricePoint {
    timestamp: number;
    price: number;
}

class BinancePriceFeed {
    private ws: WebSocket | null = null;
    private prices: PricePoint[] = [];
    private wsUrl: string;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;

    constructor(asset: string = "BTC") {
        const symbol = asset.toLowerCase() + "usdt";
        this.wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    }

    async connect(): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            this.ws = new WebSocket(this. wsUrl);

            this.ws. on("open", () => {
                console.log(`✅ Подключено к Binance (${this.wsUrl})`);
                this.reconnectAttempts = 0;
                resolvePromise();
            });

            this.ws.on("message", (data:  WebSocket.Data) => {
                try {
                    const trade = JSON.parse(data.toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();
                    this.prices.push({ timestamp, price });

                    // Храним только последние 5 минут
                    const cutoff = timestamp - 300000;
                    this.prices = this. prices.filter(p => p.timestamp > cutoff);
                } catch (e) {}
            });

            this.ws.on("error", (error) => {
                console. error("❌ Binance WebSocket ошибка:", error. message);
                reject(error);
            });

            this. ws.on("close", () => {
                console.log("⚠️ Binance WebSocket закрыт, переподключение...");
                this.reconnect();
            });
        });
    }

    private reconnect(): void {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this. reconnectAttempts++;
            setTimeout(() => this.connect(), 5000);
        }
    }

    getCurrentPrice(): number | null {
        if (this.prices. length === 0) return null;
        return this.prices[this.prices.length - 1].price;
    }

    calculateMomentum(windowSeconds: number): number | null {
        if (this.prices. length < 2) return null;

        const currentTime = Date.now();
        const cutoff = currentTime - windowSeconds * 1000;

        const pastPrices = this.prices.filter(p => p.timestamp <= cutoff);
        if (pastPrices.length === 0) return null;

        const pastPrice = pastPrices[pastPrices.length - 1].price;
        const currentPrice = this.prices[this.prices. length - 1]. price;

        return ((currentPrice - pastPrice) / pastPrice) * 100;
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ============== GAMMA API CLIENT ==============

interface CryptoMarket {
    id: string;
    question: string;
    slug: string;
    conditionId: string;
    outcomes: string[];
    upTokenId: string;
    downTokenId:  string;
    endDate: Date;
    active: boolean;
}

class GammaApiClient {
    constructor(private host: string) {}

    async getActiveMarkets(asset: string): Promise<CryptoMarket[]> {
        try {
            const res = await fetch(
                `${this.host}/markets?active=true&closed=false&order=volume&limit=200`
            );
            const data = await res.json() as any[];

            // Фильтруем по активу (btc, eth, sol)
            const assetLower = asset.toLowerCase();
            const filtered = data.filter((m: any) => {
                const slug = (m.slug || "").toLowerCase();
                return slug. includes(`${assetLower}-updown`);
            });

            return filtered.map((m: any) => {
                // Парсим tokenIds
                let tokenIds: string[] = [];
                try {
                    tokenIds = typeof m.clobTokenIds === "string" 
                        ? JSON.parse(m. clobTokenIds) 
                        :  m.clobTokenIds || [];
                } catch {}

                return {
                    id: m.id,
                    question:  m.question,
                    slug: m.slug,
                    conditionId:  m.conditionId,
                    outcomes: typeof m.outcomes === "string" ?  JSON.parse(m. outcomes) : m.outcomes,
                    upTokenId: tokenIds[0] || "",
                    downTokenId: tokenIds[1] || "",
                    endDate: new Date(m.endDate),
                    active: m.active && ! m.closed,
                };
            });
        } catch (error) {
            console.error("Ошибка Gamma API:", error);
            return [];
        }
    }

    async getNextMarket(asset: string): Promise<CryptoMarket | null> {
        const markets = await this.getActiveMarkets(asset);
        const now = Date.now();

        // Находим ближайший активный рынок который ещё не истёк
        const upcoming = markets
            .filter(m => m.endDate. getTime() > now && m.active)
            .sort((a, b) => a.endDate.getTime() - b.endDate.getTime());

        return upcoming[0] || null;
    }
}

// ============== POLYMARKET SERVICE ==============

interface MarketPrices {
    upPrice: number;
    downPrice: number;
    found: boolean;
    question: string;
    timeLeft: string;
    upTokenId: string;
    downTokenId: string;
    endDate: Date;
}

class PolymarketService {
    private clobClient: ClobClient;
    private gammaClient: GammaApiClient;
    private creds: ApiKeyCreds | null = null;

    constructor(private config: BotConfig) {
        const signer = new Wallet(config.privateKey);
        this.clobClient = new ClobClient(
            config.polymarketHost,
            config.chainId,
            signer
        );
        this.gammaClient = new GammaApiClient(config.gammaApiHost);
    }

    async initialize(): Promise<void> {
        console.log("🔑 Инициализация Polymarket клиента...");

        try {
            this.creds = await this.clobClient.createOrDeriveApiKey();
        } catch (e) {
            console.log("⚠️ API ключ недоступен, используем публичный доступ");
        }

        if (this.creds) {
            const signer = new Wallet(this.config.privateKey);
            this.clobClient = new ClobClient(
                this.config.polymarketHost,
                this. config.chainId,
                signer,
                this.creds,
                this.config.signatureType,
                this.config.funderAddress
            );
        }

        console.log("✅ Polymarket клиент инициализирован");
    }

    async getMarketPrices(): Promise<MarketPrices> {
        const market = await this.gammaClient.getNextMarket(this. config.asset);

        if (!market) {
            return {
                upPrice: 0.5,
                downPrice: 0.5,
                found:  false,
                question: "Рынок не найден",
                timeLeft: "",
                upTokenId: "",
                downTokenId: "",
                endDate: new Date(),
            };
        }

        // Получаем цены через CLOB API
        let upPrice = 0.5;
        let downPrice = 0.5;

        try {
            if (market.upTokenId) {
                const midpoint = await this.clobClient.getMidpoint(market.upTokenId);
                upPrice = parseFloat((midpoint as any)?.mid || "0.5");
            }
        } catch {}

        try {
            if (market. downTokenId) {
                const midpoint = await this.clobClient.getMidpoint(market.downTokenId);
                downPrice = parseFloat((midpoint as any)?.mid || "0.5");
            }
        } catch {}

        // Вычисляем оставшееся время
        const now = Date.now();
        const timeLeftMs = market.endDate.getTime() - now;
        const minutes = Math.floor(timeLeftMs / 60000);
        const seconds = Math.floor((timeLeftMs % 60000) / 1000);
        const timeLeft = `${minutes}м ${seconds}с`;

        return {
            upPrice,
            downPrice,
            found: true,
            question: market.question,
            timeLeft,
            upTokenId: market.upTokenId,
            downTokenId: market.downTokenId,
            endDate: market.endDate,
        };
    }

    async placeBet(tokenId: string, price: number, size: number): Promise<any> {
        if (!this.creds) {
            throw new Error("API ключ не доступен для торговли");
        }

        console.log(`\n📝 Размещаем ставку:`);
        console.log(`   Token ID: ${tokenId. substring(0, 30)}...`);
        console.log(`   Цена: ${price}`);
        console.log(`   Размер: ${size} USDC`);

        const response = await this.clobClient. createAndPostOrder(
            {
                tokenID: tokenId,
                price: price,
                side: Side.BUY,
                size: size,
            },
            { tickSize: "0.01" as any, negRisk: false },
            OrderType.GTC,
            false,
            false
        );

        console.log(`✅ Ордер размещён! `);
        return response;
    }
}

// ============== АРБИТРАЖНАЯ СТРАТЕГИЯ ==============

interface AnalysisResult {
    btcPrice: number | null;
    momentum: number | null;
    direction: "UP" | "DOWN" | "NEUTRAL";
    realProbability: number;
    marketPrices: MarketPrices;
    edge: number;
    shouldTrade: boolean;
}

class ArbitrageStrategy {
    constructor(
        private priceFeed: BinancePriceFeed,
        private polymarket: PolymarketService,
        private config: BotConfig
    ) {}

    private calculateRealProbability(momentum: number): {
        prob: number;
        direction: "UP" | "DOWN" | "NEUTRAL";
    } {
        const threshold = this. config.momentumThresholdPercent;

        if (momentum > threshold) {
            const prob = Math.min(0.85, 0.55 + (momentum / threshold) * 0.15);
            return { prob, direction: "UP" };
        } else if (momentum < -threshold) {
            const prob = Math.min(0.85, 0.55 + (Math.abs(momentum) / threshold) * 0.15);
            return { prob, direction: "DOWN" };
        } else {
            return { prob: 0.5, direction: "NEUTRAL" };
        }
    }

    async analyze(): Promise<AnalysisResult> {
        const btcPrice = this.priceFeed.getCurrentPrice();
        const momentum = this.priceFeed.calculateMomentum(this.config.momentumWindowSeconds);
        const marketPrices = await this.polymarket. getMarketPrices();

        if (momentum === null) {
            return {
                btcPrice,
                momentum:  null,
                direction: "NEUTRAL",
                realProbability: 0.5,
                marketPrices,
                edge: 0,
                shouldTrade: false,
            };
        }

        const { prob:  realProb, direction } = this.calculateRealProbability(momentum);

        let marketProb = 0.5;
        if (direction === "UP") {
            marketProb = marketPrices.upPrice;
        } else if (direction === "DOWN") {
            marketProb = marketPrices.downPrice;
        }

        const edge = (realProb - marketProb) * 100;
        const shouldTrade = edge >= this.config.minEdgePercent &&
            direction !== "NEUTRAL" &&
            marketPrices.found;

        return {
            btcPrice,
            momentum,
            direction,
            realProbability:  realProb,
            marketPrices,
            edge,
            shouldTrade,
        };
    }
}

// ============== ГЛАВНЫЙ КЛАСС БОТА ==============

class ArbitrageBot {
    private priceFeed: BinancePriceFeed;
    private polymarket: PolymarketService;
    private strategy: ArbitrageStrategy;
    private running = false;
    private lastTradeTime = 0;
    private lastDetailedLog = 0;
    private stats = {
        trades: 0,
        opportunities: 0,
        startTime: Date.now(),
    };

    constructor(private config: BotConfig) {
        this.priceFeed = new BinancePriceFeed(config.asset);
        this.polymarket = new PolymarketService(config);
        this.strategy = new ArbitrageStrategy(
            this.priceFeed,
            this.polymarket,
            config
        );
    }

    async start(): Promise<void> {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🤖 POLYMARKET ${this.config.asset} 5-MIN ARBITRAGE BOT              ║
╠══════════════════════════════════════════════════════════════╣
║  Актив:  ${this.config.asset}                                              ║
║  Минимальный edge: ${this.config.minEdgePercent}%                                   ║
║  Размер ставки: $${this.config. betSizeUsdc}                                        ║
║  Окно моментума: ${this.config.momentumWindowSeconds}s                                     ║
╚══════════════════════════════════════════════════════════════╝
        `);

        await this.priceFeed.connect();
        await this.polymarket.initialize();

        console.log("⏳ Накапливаем данные о ценах (35 секунд)...");
        await this. sleep(35000);

        console.log("🚀 Бот запущен!\n");

        this.running = true;
        await this.mainLoop();
    }

    private async mainLoop(): Promise<void> {
        while (this.running) {
            try {
                const analysis = await this.strategy.analyze();
                const now = Date.now();

                // Подробный статус каждые 5 секунд
                if (now - this. lastDetailedLog >= 5000) {
                    this. printDetailedStatus(analysis);
                    this.lastDetailedLog = now;
                }

                // Проверяем cooldown
                const timeSinceLastTrade = (now - this.lastTradeTime) / 1000;
                if (timeSinceLastTrade < this.config.cooldownSeconds && this.lastTradeTime > 0) {
                    await this.sleep(1000);
                    continue;
                }

                // Если есть возможность
                if (analysis. shouldTrade) {
                    this.stats.opportunities++;

                    const tokenId = analysis.direction === "UP"
                        ? analysis.marketPrices.upTokenId
                        : analysis. marketPrices. downTokenId;

                    console.log(`\n🎯 АРБИТРАЖНАЯ ВОЗМОЖНОСТЬ! `);
                    console.log(`   Направление: ${analysis. direction}`);
                    console.log(`   Edge: ${analysis.edge. toFixed(2)}%`);
                    console.log(`   Наша оценка: ${(analysis.realProbability * 100).toFixed(1)}%`);
                    console.log(`   Цена рынка: ${(analysis.direction === "UP" ?  analysis.marketPrices.upPrice :  analysis.marketPrices.downPrice) * 100}%`);

                    // РАСКОММЕНТИРУЙТЕ ДЛЯ РЕАЛЬНОЙ ТОРГОВЛИ:
                    /*
                    if (tokenId) {
                        await this.polymarket. placeBet(
                            tokenId,
                            analysis. direction === "UP" ?  analysis.marketPrices.upPrice + 0.01 :  analysis.marketPrices.downPrice + 0.01,
                            this.config.betSizeUsdc
                        );
                        this.stats.trades++;
                        this.lastTradeTime = Date.now();
                    }
                    */

                    console.log(`   ⚠️ СИМУЛЯЦИЯ - ордер НЕ размещён\n`);
                }

                await this. sleep(1000);
            } catch (error) {
                console.error("\n❌ Ошибка:", error);
                await this.sleep(5000);
            }
        }
    }

    private printDetailedStatus(analysis: AnalysisResult): void {
        const arrow = analysis.momentum !== null
            ? (analysis.momentum > 0 ?  "📈" : analysis.momentum < 0 ? "📉" : "➡️")
            : "⏳";

        console.log(`
┌─────────────────────────────────────────────────────────────┐
│ ${arrow} BINANCE ${this.config.asset}:    $${analysis.btcPrice?.toFixed(2) || "N/A"}                              
│    Моментум (${this.config.momentumWindowSeconds}s): ${analysis.momentum?. toFixed(4) || "N/A"}%                          
├─────────────────────────────────────────────────────────────┤
│ 🎰 POLYMARKET:   ${analysis.marketPrices.found ? "✅" : "❌"} ${analysis.marketPrices.question. substring(0, 35)}
│    ⬆️  UP:     ${(analysis.marketPrices.upPrice * 100).toFixed(1)}%                                    
│    ⬇️  DOWN:  ${(analysis.marketPrices.downPrice * 100).toFixed(1)}%                                  
│    ⏱️  Осталось: ${analysis.marketPrices.timeLeft || "N/A"}                            
├─────────────────────────────────────────────────────────────┤
│ 🧠 АНАЛИЗ:  ${analysis.direction}                                       
│    Наша оценка:   ${(analysis. realProbability * 100).toFixed(1)}%                              
│    Edge:  ${analysis.edge. toFixed(2)}% ${analysis.shouldTrade ? "🎯 СИГНАЛ!" : ""}                                   
├─────────────────────────────────────────────────────────────┤
│ 📊 Возможностей:  ${this.stats.opportunities} | Сделок: ${this.stats.trades}                      
└─────────────────────────────────────────────────────────────┘`);
    }

    stop(): void {
        console.log("\n🛑 Останавливаем бота...");
        this.running = false;
        this.priceFeed.disconnect();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ============== ЗАПУСК ==============

async function main() {
    const bot = new ArbitrageBot(botConfig);

    process.on("SIGINT", () => {
        bot.stop();
        process.exit(0);
    });

    try {
        await bot.start();
    } catch (error) {
        console. error("Критическая ошибка:", error);
        process.exit(1);
    }
}

main();
