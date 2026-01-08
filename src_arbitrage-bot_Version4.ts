/**
 * Polymarket 15-MIN Crypto Arbitrage Bot v2
 * С улучшенной стратегией
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
    minEdgePercent:  number;
    betSizeUsdc: number;
    momentumWindowSeconds: number;
    momentumThresholdPercent: number;
    cooldownSeconds:  number;
    asset: "btc" | "eth" | "sol" | "xrp";
}

const botConfig: BotConfig = {
    polymarketHost: "https://clob.polymarket. com",
    gammaApiHost: "https://gamma-api.polymarket. com",
    chainId: 137 as Chain,
    privateKey: process. env.PRIVATE_KEY || "",
    funderAddress: process.env. FUNDER_ADDRESS || "",
    signatureType: 1,
    
    // ========== НАСТРОЙКИ СТРАТЕГИИ ==========
    minEdgePercent: 2.0,              // Минимальный edge для входа (было 5%)
    betSizeUsdc:  50,                  // Размер ставки
    momentumWindowSeconds: 60,         // Окно анализа (было 30 сек)
    momentumThresholdPercent: 0.05,   // Порог моментума (было 0.15%)
    cooldownSeconds: 30,               // Пауза между сделками
    // =========================================
    
    asset: "btc",
};

// ============== BINANCE PRICE FEED ==============

interface PricePoint {
    timestamp: number;
    price: number;
}

class BinancePriceFeed {
    private ws: WebSocket | null = null;
    private prices: PricePoint[] = [];
    private wsUrl:  string;
    private reconnectAttempts = 0;

    constructor(asset: string = "btc") {
        const symbol = asset.toLowerCase() + "usdt";
        this. wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    }

    async connect(): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            this.ws = new WebSocket(this. wsUrl);

            this.ws. on("open", () => {
                console.log(`✅ Binance WebSocket подключён`);
                this.reconnectAttempts = 0;
                resolvePromise();
            });

            this.ws.on("message", (data:  WebSocket.Data) => {
                try {
                    const trade = JSON.parse(data. toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();
                    this.prices.push({ timestamp, price });

                    // Храним 10 минут данных
                    const cutoff = timestamp - 600000;
                    this.prices = this. prices.filter(p => p.timestamp > cutoff);
                } catch (e) {}
            });

            this.ws.on("error", reject);
            this.ws.on("close", () => {
                if (this. reconnectAttempts < 10) {
                    this.reconnectAttempts++;
                    setTimeout(() => this.connect(), 5000);
                }
            });
        });
    }

    getCurrentPrice(): number | null {
        if (this.prices.length === 0) return null;
        return this.prices[this.prices.length - 1].price;
    }

    // Моментум:  изменение цены за период
    calculateMomentum(windowSeconds: number): number | null {
        if (this.prices. length < 2) return null;

        const now = Date.now();
        const cutoff = now - windowSeconds * 1000;

        const pastPrices = this.prices.filter(p => p.timestamp <= cutoff);
        if (pastPrices.length === 0) return null;

        const pastPrice = pastPrices[pastPrices.length - 1].price;
        const currentPrice = this.prices[this.prices. length - 1]. price;

        return ((currentPrice - pastPrice) / pastPrice) * 100;
    }

    // Волатильность: стандартное отклонение цены
    calculateVolatility(windowSeconds: number): number | null {
        const now = Date.now();
        const cutoff = now - windowSeconds * 1000;
        const recentPrices = this.prices.filter(p => p. timestamp > cutoff);

        if (recentPrices. length < 10) return null;

        const prices = recentPrices.map(p => p.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        
        return (Math.sqrt(variance) / mean) * 100;
    }

    // Тренд: сравниваем несколько периодов
    calculateTrend(): { short: number | null; medium: number | null; direction: string } {
        const short = this.calculateMomentum(30);  // 30 сек
        const medium = this.calculateMomentum(120); // 2 мин

        let direction = "NEUTRAL";
        if (short !== null && medium !== null) {
            if (short > 0 && medium > 0) direction = "STRONG_UP";
            else if (short < 0 && medium < 0) direction = "STRONG_DOWN";
            else if (short > 0) direction = "WEAK_UP";
            else if (short < 0) direction = "WEAK_DOWN";
        }

        return { short, medium, direction };
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
    static get15MinTimestamps(): { current: number; next: number } {
        const now = Math.floor(Date. now() / 1000);
        const minutes = Math.floor((now % 3600) / 60);
        const currentSlot = Math.floor(minutes / 15) * 15;
        
        const hourStart = now - (now % 3600);
        const currentTimestamp = hourStart + currentSlot * 60;
        const nextTimestamp = currentTimestamp + 15 * 60;
        
        return { current: currentTimestamp, next:  nextTimestamp };
    }

    static formatSlug(asset: string, timestamp: number): string {
        return `${asset.toLowerCase()}-updown-15m-${timestamp}`;
    }

    static getTimeLeft(endTimestamp: number): string {
        const now = Math.floor(Date.now() / 1000);
        const secondsLeft = endTimestamp + 15 * 60 - now;
        
        if (secondsLeft <= 0) return "Истёк";
        
        const minutes = Math. floor(secondsLeft / 60);
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
    downTokenId: string;
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
            if (!res.ok) return null;

            const m = await res.json() as any;

            let tokenIds:  string[] = [];
            try {
                tokenIds = typeof m.clobTokenIds === "string"
                    ? JSON.parse(m. clobTokenIds)
                    : m.clobTokenIds || [];
            } catch {}

            let prices: number[] = [0.5, 0.5];
            try {
                prices = typeof m.outcomePrices === "string"
                    ? JSON.parse(m.outcomePrices).map((p: string) => parseFloat(p))
                    : m.outcomePrices?. map((p: string) => parseFloat(p)) || [0.5, 0.5];
            } catch {}

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
        } catch {
            return null;
        }
    }

    async getCurrentMarket(asset: string): Promise<Market15m | null> {
        const { current, next } = MarketCalculator.get15MinTimestamps();
        
        const currentSlug = MarketCalculator.formatSlug(asset, current);
        let market = await this.getMarketBySlug(currentSlug);
        
        if (market && market.active) return market;

        const nextSlug = MarketCalculator.formatSlug(asset, next);
        return await this.getMarketBySlug(nextSlug);
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
    marketBias: "UP" | "DOWN" | "NEUTRAL";
}

class PolymarketService {
    private clobClient: ClobClient;
    private gammaClient: GammaApiClient;
    private creds: ApiKeyCreds | null = null;

    constructor(private config: BotConfig) {
        const signer = new Wallet(config.privateKey);
        this.clobClient = new ClobClient(config. polymarketHost, config.chainId, signer);
        this.gammaClient = new GammaApiClient(config.gammaApiHost);
    }

    async initialize(): Promise<void> {
        console.log("🔑 Инициализация.. .");
        try {
            this. creds = await this.clobClient.createOrDeriveApiKey();
        } catch {}

        if (this.creds) {
            const signer = new Wallet(this.config.privateKey);
            this.clobClient = new ClobClient(
                this.config. polymarketHost,
                this.config.chainId,
                signer,
                this.creds,
                this.config.signatureType,
                this.config.funderAddress
            );
        }
        console.log("✅ Готово");
    }

    async getMarketPrices(): Promise<MarketPrices> {
        const market = await this. gammaClient.getCurrentMarket(this.config.asset);

        if (!market) {
            return {
                upPrice: 0.5, downPrice: 0.5, found: false,
                question: "Рынок не найден", timeLeft: "",
                upTokenId: "", downTokenId: "", slug: "",
                marketBias: "NEUTRAL",
            };
        }

        const timeLeft = MarketCalculator.getTimeLeft(market.endTimestamp);
        
        // Определяем bias рынка
        let marketBias:  "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
        if (market.upPrice > 0.52) marketBias = "UP";
        else if (market. downPrice > 0.52) marketBias = "DOWN";

        return {
            upPrice: market. upPrice,
            downPrice: market. downPrice,
            found: true,
            question: market. question,
            timeLeft,
            upTokenId: market. upTokenId,
            downTokenId:  market.downTokenId,
            slug:  market.slug,
            marketBias,
        };
    }

    async placeBet(tokenId: string, price: number, size: number): Promise<any> {
        if (!this.creds) throw new Error("No API key");

        console.log(`📝 Ставка:  ${tokenId. substring(0, 20)}... @ ${price} x ${size} USDC`);

        return await this.clobClient.createAndPostOrder(
            { tokenID: tokenId, price, side: Side.BUY, size },
            { tickSize: "0.01" as any, negRisk: false },
            OrderType.GTC, false, false
        );
    }
}

// ============== УЛУЧШЕННАЯ СТРАТЕГИЯ ==============

interface AnalysisResult {
    price: number | null;
    momentum: number | null;
    volatility: number | null;
    trend:  { short: number | null; medium: number | null; direction: string };
    direction: "UP" | "DOWN" | "NEUTRAL";
    confidence: number;
    realProbability: number;
    marketPrices: MarketPrices;
    edge: number;
    shouldTrade: boolean;
    reason: string;
}

class ImprovedStrategy {
    constructor(
        private priceFeed: BinancePriceFeed,
        private polymarket: PolymarketService,
        private config: BotConfig
    ) {}

    async analyze(): Promise<AnalysisResult> {
        const price = this.priceFeed.getCurrentPrice();
        const momentum = this.priceFeed.calculateMomentum(this.config.momentumWindowSeconds);
        const volatility = this. priceFeed. calculateVolatility(60);
        const trend = this.priceFeed.calculateTrend();
        const marketPrices = await this.polymarket. getMarketPrices();

        // Базовый результат
        const result: AnalysisResult = {
            price, momentum, volatility, trend,
            direction:  "NEUTRAL",
            confidence: 0,
            realProbability: 0. 5,
            marketPrices,
            edge: 0,
            shouldTrade: false,
            reason: "",
        };

        if (momentum === null) {
            result.reason = "Недостаточно данных";
            return result;
        }

        // ========== УЛУЧШЕННЫЙ РАСЧЁТ ВЕРОЯТНОСТИ ==========
        
        const threshold = this.config.momentumThresholdPercent;
        let confidence = 0;
        let direction:  "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";

        // 1. Базовый сигнал от моментума
        if (Math.abs(momentum) > threshold) {
            direction = momentum > 0 ? "UP" : "DOWN";
            confidence += 0.3;
        }

        // 2. Усиление от тренда
        if (trend.direction === "STRONG_UP" && direction === "UP") {
            confidence += 0.2;
        } else if (trend.direction === "STRONG_DOWN" && direction === "DOWN") {
            confidence += 0.2;
        }

        // 3. Согласие с рынком (contrarian или confirmation)
        if (marketPrices. marketBias === direction && direction !== "NEUTRAL") {
            // Рынок согласен — небольшое подтверждение
            confidence += 0.1;
        } else if (marketPrices.marketBias !== "NEUTRAL" && marketPrices.marketBias !== direction) {
            // Рынок не согласен — либо мы умнее, либо ошибаемся
            // Не добавляем и не убавляем
        }

        // 4. Волатильность (высокая = больше возможностей)
        if (volatility !== null && volatility > 0.05) {
            confidence += 0.1;
        }

        // Финальная вероятность
        let realProbability = 0.5;
        if (direction !== "NEUTRAL") {
            realProbability = 0.5 + confidence * 0.35; // Max ~0.67
            realProbability = Math.min(0.75, Math.max(0.5, realProbability));
        }

        // Edge расчёт
        let marketProb = 0.5;
        if (direction === "UP") marketProb = marketPrices.upPrice;
        else if (direction === "DOWN") marketProb = marketPrices.downPrice;

        const edge = (realProbability - marketProb) * 100;

        // Решение о торговле
        const shouldTrade = edge >= this.config.minEdgePercent && 
                           direction !== "NEUTRAL" && 
                           marketPrices.found &&
                           confidence >= 0.3;

        let reason = "";
        if (!marketPrices.found) reason = "Рынок не найден";
        else if (direction === "NEUTRAL") reason = `Моментум ${momentum. toFixed(4)}% < порог ${threshold}%`;
        else if (confidence < 0.3) reason = `Низкая уверенность ${(confidence * 100).toFixed(0)}%`;
        else if (edge < this.config.minEdgePercent) reason = `Edge ${edge.toFixed(2)}% < мин ${this.config.minEdgePercent}%`;
        else reason = "✅ Сигнал! ";

        return {
            ... result,
            direction,
            confidence,
            realProbability,
            edge,
            shouldTrade,
            reason,
        };
    }
}

// ============== ГЛАВНЫЙ КЛАСС БОТА ==============

class ArbitrageBot {
    private priceFeed: BinancePriceFeed;
    private polymarket: PolymarketService;
    private strategy:  ImprovedStrategy;
    private running = false;
    private lastTradeTime = 0;
    private lastLog = 0;
    private stats = { trades: 0, opportunities: 0, wins: 0, losses: 0 };

    constructor(private config: BotConfig) {
        this.priceFeed = new BinancePriceFeed(config.asset);
        this.polymarket = new PolymarketService(config);
        this.strategy = new ImprovedStrategy(this.priceFeed, this.polymarket, config);
    }

    async start(): Promise<void> {
        console. log(`
╔═══════���═══════════════════════════════════════════════════════╗
║  🤖 POLYMARKET ${this.config.asset. toUpperCase()} 15-MIN ARBITRAGE BOT v2          ║
╠═══════════════════════════════════════════════════════════════╣
║  Edge: ${this.config.minEdgePercent}% | Порог: ${this. config.momentumThresholdPercent}% | Окно: ${this. config.momentumWindowSeconds}s | Ставка: $${this.config. betSizeUsdc}  ║
╚═══════════════════════════════════════════════════════════════╝`);

        await this.priceFeed.connect();
        await this.polymarket.initialize();

        console.log("⏳ Накапливаем данные (60 сек)...");
        await this.sleep(60000);

        console.log("🚀 Бот запущен!\n");
        this.running = true;
        await this.mainLoop();
    }

    private async mainLoop(): Promise<void> {
        while (this.running) {
            try {
                const a = await this.strategy.analyze();
                const now = Date.now();

                if (now - this. lastLog >= 3000) {
                    this.printStatus(a);
                    this.lastLog = now;
                }

                if ((now - this.lastTradeTime) / 1000 < this.config.cooldownSeconds && this.lastTradeTime > 0) {
                    await this.sleep(1000);
                    continue;
                }

                if (a.shouldTrade) {
                    this.stats.opportunities++;
                    const tokenId = a.direction === "UP" ?  a.marketPrices.upTokenId : a.marketPrices.downTokenId;

                    console.log(`\n🎯 ${a.direction} | Edge: ${a.edge.toFixed(2)}% | Уверенность: ${(a.confidence * 100).toFixed(0)}%`);

                    // РАСКОММЕНТИРУЙТЕ ДЛЯ РЕАЛЬНОЙ ТОРГОВЛИ: 
                    /*
                    if (tokenId) {
                        const price = a.direction === "UP"
                            ? Math.min(a.marketPrices.upPrice + 0.01, 0.95)
                            : Math.min(a.marketPrices.downPrice + 0.01, 0.95);
                        await this.polymarket.placeBet(tokenId, price, this.config.betSizeUsdc);
                        this.stats.trades++;
                        this.lastTradeTime = Date.now();
                    }
                    */

                    console.log(`   ⚠️ СИМУЛЯЦИЯ\n`);
                }

                await this. sleep(1000);
            } catch (error) {
                console.error("❌", error);
                await this.sleep(5000);
            }
        }
    }

    private printStatus(a: AnalysisResult): void {
        const arrow = a.momentum !== null
            ? (a.momentum > 0 ? "📈" : a. momentum < 0 ? "📉" : "➡️") :  "⏳";
        const trendIcon = a.trend. direction. includes("STRONG") ? "💪" : 
                         a. trend.direction.includes("WEAK") ? "〰️" : "➖";

        console.log(`
┌───────────────────────────────────────────────────────────────┐
│ ${arrow} ${this.config.asset. toUpperCase()}: $${a.price?. toFixed(2) || "N/A"}  Mom: ${a.momentum?.toFixed(4) || "N/A"}%  Vol: ${a.volatility?.toFixed(3) || "N/A"}%
│ ${trendIcon} Тренд: ${a.trend.direction}  (30s:  ${a.trend. short?.toFixed(4) || "N/A"}% | 2m: ${a.trend.medium?.toFixed(4) || "N/A"}%)
├───────────────────────────────────────────────────────────────┤
│ 🎰 ${a.marketPrices.slug || "N/A"}
│    UP: ${(a.marketPrices.upPrice * 100).toFixed(1)}%  DOWN: ${(a.marketPrices.downPrice * 100).toFixed(1)}%  ⏱️ ${a. marketPrices.timeLeft}  Bias: ${a.marketPrices.marketBias}
├───────────────────────────────────────────────────────────────┤
│ 🧠 ${a.direction} | Оценка: ${(a.realProbability * 100).toFixed(1)}% | Edge: ${a.edge.toFixed(2)}% | Уверенность: ${(a.confidence * 100).toFixed(0)}%
│ 💬 ${a.reason}
├───────────────────────────────────────────────────────────────┤
│ 📊 Возможностей: ${this.stats.opportunities} | Сделок: ${this.stats.trades}
└───────────────────────────────────────────────────────────────┘`);
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
    process.on("SIGINT", () => { bot.stop(); process.exit(0); });

    try {
        await bot.start();
    } catch (error) {
        console. error("Критическая ошибка:", error);
        process.exit(1);
    }
}

main();
