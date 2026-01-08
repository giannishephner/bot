/**
 * Polymarket 15-MIN Crypto Arbitrage Bot
 * Использует правильный API endpoint:  /markets/slug/{asset}-updown-15m-{timestamp}
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
    asset: "btc" | "eth" | "sol" | "xrp";
}

const botConfig: BotConfig = {
    polymarketHost: "https://clob.polymarket. com",
    gammaApiHost: "https://gamma-api.polymarket.com",
    chainId: 137 as Chain,
    privateKey: process. env.PRIVATE_KEY || "",
    funderAddress: process.env.FUNDER_ADDRESS || "",
    signatureType: 1,
    minEdgePercent:  5. 0,
    betSizeUsdc:  50,
    momentumWindowSeconds: 30,
    momentumThresholdPercent: 0.15,
    cooldownSeconds: 60,
    asset:  "btc",
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

    constructor(asset: string = "btc") {
        const symbol = asset.toLowerCase() + "usdt";
        this.wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    }

    async connect(): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            this.ws = new WebSocket(this.wsUrl);

            this.ws. on("open", () => {
                console.log(`✅ Binance WebSocket подключён`);
                this.reconnectAttempts = 0;
                resolvePromise();
            });

            this.ws.on("message", (data:  WebSocket.Data) => {
                try {
                    const trade = JSON.parse(data.toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();
                    this.prices.push({ timestamp, price });

                    const cutoff = timestamp - 300000;
                    this. prices = this.prices.filter(p => p.timestamp > cutoff);
                } catch (e) {}
            });

            this.ws.on("error", (error) => {
                reject(error);
            });

            this. ws.on("close", () => {
                if (this. reconnectAttempts < 10) {
                    this.reconnectAttempts++;
                    setTimeout(() => this.connect(), 5000);
                }
            });
        });
    }

    getCurrentPrice(): number | null {
        if (this. prices.length === 0) return null;
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

// ============== 15-MIN MARKET CALCULATOR ==============

class MarketCalculator {
    /**
     * Вычисляет timestamp для текущего/следующего 15-минутного окна
     * Рынки начинаются каждые 15 минут:  : 00, :15, :30, :45
     */
    static get15MinTimestamps(): { current: number; next:  number } {
        const now = Math.floor(Date. now() / 1000);
        const minutes = Math.floor((now % 3600) / 60);
        const currentSlot = Math.floor(minutes / 15) * 15;
        
        // Текущее 15-минутное окно
        const hourStart = now - (now % 3600);
        const currentTimestamp = hourStart + currentSlot * 60;
        
        // Следующее окно
        const nextTimestamp = currentTimestamp + 15 * 60;
        
        return { current: currentTimestamp, next: nextTimestamp };
    }

    static formatSlug(asset: string, timestamp: number): string {
        return `${asset.toLowerCase()}-updown-15m-${timestamp}`;
    }

    static getTimeLeft(endTimestamp: number): string {
        const now = Math.floor(Date.now() / 1000);
        const secondsLeft = endTimestamp + 15 * 60 - now; // +15 мин = конец окна
        
        if (secondsLeft <= 0) return "Истёк";
        
        const minutes = Math.floor(secondsLeft / 60);
        const seconds = secondsLeft % 60;
        return `${minutes}м ${seconds}с`;
    }
}

// ============== GAMMA API CLIENT ==============

interface Market15m {
    id:  string;
    question: string;
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId:  string;
    upPrice: number;
    downPrice: number;
    endTimestamp: number;
    active: boolean;
}

class GammaApiClient {
    constructor(private host: string) {}

    async getMarketBySlug(slug:  string): Promise<Market15m | null> {
        try {
            const res = await fetch(`${this.host}/markets/slug/${slug}`);
            
            if (!res. ok) {
                return null;
            }

            const m = await res.json() as any;

            // Парсим tokenIds
            let tokenIds: string[] = [];
            try {
                tokenIds = typeof m.clobTokenIds === "string"
                    ? JSON.parse(m. clobTokenIds)
                    : m.clobTokenIds || [];
            } catch {}

            // Парсим цены
            let prices: number[] = [0. 5, 0.5];
            try {
                prices = typeof m.outcomePrices === "string"
                    ? JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p))
                    : m.outcomePrices?.map((p: string) => parseFloat(p)) || [0.5, 0.5];
            } catch {}

            // Извлекаем timestamp из slug
            const timestampMatch = slug.match(/(\d{10})$/);
            const endTimestamp = timestampMatch ? parseInt(timestampMatch[1]) : 0;

            return {
                id: m. id,
                question: m.question,
                slug: m.slug,
                conditionId: m.conditionId,
                upTokenId: tokenIds[0] || "",
                downTokenId: tokenIds[1] || "",
                upPrice:  prices[0] || 0.5,
                downPrice: prices[1] || 0.5,
                endTimestamp,
                active: m.active && ! m.closed,
            };
        } catch (error) {
            return null;
        }
    }

    async getCurrentMarket(asset: string): Promise<Market15m | null> {
        const { current, next } = MarketCalculator.get15MinTimestamps();
        
        // Пробуем текущий рынок
        const currentSlug = MarketCalculator.formatSlug(asset, current);
        let market = await this. getMarketBySlug(currentSlug);
        
        if (market && market.active) {
            return market;
        }

        // Если текущий не активен, пробуем следующий
        const nextSlug = MarketCalculator.formatSlug(asset, next);
        market = await this.getMarketBySlug(nextSlug);
        
        return market;
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
    slug: string;
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
        console.log("🔑 Инициализация Polymarket.. .");

        try {
            this.creds = await this.clobClient.createOrDeriveApiKey();
        } catch (e) {
            console.log("⚠️ API ключ недоступен");
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

        console.log("✅ Polymarket инициализирован");
    }

    async getMarketPrices(): Promise<MarketPrices> {
        const market = await this.gammaClient.getCurrentMarket(this.config.asset);

        if (!market) {
            return {
                upPrice: 0.5,
                downPrice: 0.5,
                found: false,
                question: "Рынок не найден",
                timeLeft: "",
                upTokenId: "",
                downTokenId: "",
                slug: "",
            };
        }

        const timeLeft = MarketCalculator.getTimeLeft(market.endTimestamp);

        return {
            upPrice: market.upPrice,
            downPrice: market.downPrice,
            found:  true,
            question: market.question,
            timeLeft,
            upTokenId: market.upTokenId,
            downTokenId: market. downTokenId,
            slug: market. slug,
        };
    }

    async placeBet(tokenId: string, price: number, size: number): Promise<any> {
        if (!this.creds) {
            throw new Error("API ключ не доступен");
        }

        console.log(`\n📝 Ставка:  ${tokenId. substring(0, 20)}... @ ${price} x ${size} USDC`);

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

// ============== АРБИТРАЖН��Я СТРАТЕГИЯ ==============

interface AnalysisResult {
    price: number | null;
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
        const threshold = this.config.momentumThresholdPercent;

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
        const price = this.priceFeed.getCurrentPrice();
        const momentum = this.priceFeed.calculateMomentum(this.config.momentumWindowSeconds);
        const marketPrices = await this.polymarket. getMarketPrices();

        if (momentum === null) {
            return {
                price,
                momentum: null,
                direction:  "NEUTRAL",
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
            price,
            momentum,
            direction,
            realProbability: realProb,
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
║     🤖 POLYMARKET ${this.config.asset. toUpperCase()} 15-MIN ARBITRAGE BOT              ║
╠══════════════════════════════════════════════════════════════╣
║  Актив:  ${this.config. asset.toUpperCase()}  |  Edge: ${this.config.minEdgePercent}%  |  Ставка: $${this.config.betSizeUsdc}            ║
╚══════════════════════════════════════════════════════════════╝
        `);

        await this.priceFeed.connect();
        await this.polymarket.initialize();

        console.log("⏳ Накапливаем данные (35 сек)...");
        await this.sleep(35000);

        console.log("🚀 Бот запущен!\n");

        this.running = true;
        await this.mainLoop();
    }

    private async mainLoop(): Promise<void> {
        while (this.running) {
            try {
                const analysis = await this.strategy. analyze();
                const now = Date.now();

                if (now - this.lastDetailedLog >= 5000) {
                    this.printStatus(analysis);
                    this.lastDetailedLog = now;
                }

                const timeSinceLastTrade = (now - this.lastTradeTime) / 1000;
                if (timeSinceLastTrade < this.config.cooldownSeconds && this.lastTradeTime > 0) {
                    await this. sleep(1000);
                    continue;
                }

                if (analysis.shouldTrade) {
                    this.stats.opportunities++;

                    const tokenId = analysis.direction === "UP"
                        ? analysis.marketPrices.upTokenId
                        : analysis. marketPrices. downTokenId;

                    console.log(`\n🎯 СИГНАЛ: ${analysis.direction} | Edge: ${analysis.edge. toFixed(2)}%`);

                    // РАСКОММЕНТИРУЙТЕ ДЛЯ РЕАЛЬНОЙ ТОРГОВЛИ: 
                    /*
                    if (tokenId) {
                        const price = analysis.direction === "UP"
                            ? Math.min(analysis.marketPrices.upPrice + 0.01, 0.99)
                            :  Math.min(analysis.marketPrices.downPrice + 0.01, 0.99);
                        await this.polymarket.placeBet(tokenId, price, this.config.betSizeUsdc);
                        this.stats.trades++;
                        this.lastTradeTime = Date.now();
                    }
                    */

                    console.log(`   ⚠️ СИМУЛЯЦИЯ\n`);
                }

                await this. sleep(1000);
            } catch (error) {
                console.error("❌ Ошибка:", error);
                await this.sleep(5000);
            }
        }
    }

    private printStatus(a: AnalysisResult): void {
        const arrow = a.momentum !== null
            ? (a.momentum > 0 ?  "📈" : a. momentum < 0 ? "📉" : "➡️")
            : "⏳";

        console. log(`
┌──────────────────────────────────────────────────────────────┐
│ ${arrow} BINANCE ${this.config.asset. toUpperCase()}:   $${a.price?. toFixed(2) || "N/A"}  Моментум: ${a.momentum?.toFixed(4) || "N/A"}%
├──────────────────────────────────────────────────────────────┤
│ 🎰 POLYMARKET:  ${a.marketPrices.found ?  "✅" : "❌"} ${a.marketPrices.slug || "N/A"}
│    UP: ${(a.marketPrices.upPrice * 100).toFixed(1)}%  DOWN: ${(a. marketPrices. downPrice * 100).toFixed(1)}%  ⏱️ ${a.marketPrices.timeLeft || "N/A"}
├──────────────────────────────────────────────────────────────┤
│ 🧠 ${a.direction} | Оценка: ${(a.realProbability * 100).toFixed(1)}% | Edge: ${a.edge.toFixed(2)}% ${a.shouldTrade ? "🎯" : ""}
│ 📊 Возможностей: ${this.stats.opportunities} | Сделок: ${this. stats.trades}
└──────────────────────────────────────────────────────────────┘`);
    }

    stop(): void {
        console.log("\n🛑 Стоп");
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
