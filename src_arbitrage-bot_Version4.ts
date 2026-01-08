/**
 * Polymarket BTC 15-minute Arbitrage Bot
 * Использует Gamma API для поиска 15-min рынков
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
}

const botConfig: BotConfig = {
    polymarketHost: "https://clob.polymarket. com",
    gammaApiHost: "https://gamma-api.polymarket.com",
    chainId: 137 as Chain,
    privateKey: process. env.PRIVATE_KEY || "",
    funderAddress: process.env. FUNDER_ADDRESS || "",
    signatureType: 1,
    minEdgePercent: 5. 0,
    betSizeUsdc:  50,
    momentumWindowSeconds: 30,
    momentumThresholdPercent: 0.15,
    cooldownSeconds: 60,
};

// ============== BINANCE PRICE FEED ==============

interface PricePoint {
    timestamp: number;
    price: number;
}

class BinancePriceFeed {
    private ws: WebSocket | null = null;
    private prices: PricePoint[] = [];
    private readonly wsUrl = "wss://stream.binance.com:9443/ws/btcusdt@trade";
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;

    async connect(): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            this.ws = new WebSocket(this. wsUrl);

            this.ws. on("open", () => {
                console.log("✅ Подключено к Binance WebSocket");
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
                console.error("❌ Binance WebSocket ошибка:", error. message);
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
        if (this.prices.length < 2) return null;

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

interface GammaMarket {
    id:  string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string[];
    outcomePrices: string[];
    clobTokenIds: string[];
    active: boolean;
    closed: boolean;
    endDate: string;
}

class GammaApiClient {
    constructor(private host: string) {}

    async findBtc15MinMarkets(): Promise<GammaMarket[]> {
        try {
            // Ищем активные 15-минутные BTC рынки
            const response = await fetch(
                `${this.host}/markets? closed=false&active=true`
            );
            const markets:  any[] = await response.json();

            // Фильтруем 15-минутные BTC рынки
            const btcMarkets = markets.filter((m: any) => {
                const question = (m.question || "").toLowerCase();
                const slug = (m. slug || "").toLowerCase();
                
                return (
                    (question.includes("btc") || question.includes("bitcoin")) &&
                    (question.includes("15") || slug.includes("15m")) &&
                    m.active === true &&
                    m. closed === false
                );
            });

            return btcMarkets.map((m: any) => ({
                id: m.id,
                question: m.question,
                conditionId: m.conditionId,
                slug: m.slug,
                outcomes:  m.outcomes || [],
                outcomePrices: m.outcomePrices || [],
                clobTokenIds:  m.clobTokenIds || [],
                active: m.active,
                closed:  m.closed,
                endDate: m.endDate,
            }));
        } catch (error) {
            console.error("Ошибка Gamma API:", error);
            return [];
        }
    }

    async getCurrentBtc15MinMarket(): Promise<GammaMarket | null> {
        const markets = await this.findBtc15MinMarkets();
        
        if (markets. length === 0) {
            // Попробуем другой поиск
            try {
                const response = await fetch(`${this.host}/markets?tag=crypto&closed=false`);
                const allMarkets:  any[] = await response.json();
                
                const btc15m = allMarkets. find((m: any) => {
                    const q = (m.question || "").toLowerCase();
                    const s = (m.slug || "").toLowerCase();
                    return s.includes("btc") && s.includes("15m") && ! m.closed;
                });
                
                if (btc15m) {
                    return {
                        id:  btc15m. id,
                        question: btc15m.question,
                        conditionId: btc15m.conditionId,
                        slug:  btc15m. slug,
                        outcomes: btc15m.outcomes || [],
                        outcomePrices:  btc15m. outcomePrices || [],
                        clobTokenIds:  btc15m. clobTokenIds || [],
                        active: btc15m.active,
                        closed: btc15m.closed,
                        endDate: btc15m.endDate,
                    };
                }
            } catch (e) {}
            
            return null;
        }

        // Возвращаем ближайший к истечению активный рынок
        const now = Date.now();
        const sorted = markets
            .filter(m => new Date(m.endDate).getTime() > now)
            .sort((a, b) => 
                new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
            );

        return sorted[0] || null;
    }
}

// ============== POLYMARKET SERVICE ==============

interface MarketPrices {
    upPrice: number;
    downPrice: number;
    found: boolean;
    question: string;
    endDate: string;
    timeLeft: string;
    upTokenId: string;
    downTokenId: string;
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
            console. log("⚠️ API ключ недоступен, используем публичный доступ");
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

        console. log("✅ Polymarket клиент инициализирован");
    }

    async getMarketPrices(): Promise<MarketPrices> {
        const market = await this.gammaClient.getCurrentBtc15MinMarket();

        if (!market) {
            return {
                upPrice: 0.5,
                downPrice: 0.5,
                found:  false,
                question: "Рынок не найден",
                endDate: "",
                timeLeft:  "",
                upTokenId: "",
                downTokenId: "",
            };
        }

        // Парсим цены и�� Gamma API
        let upPrice = 0.5;
        let downPrice = 0.5;
        let upTokenId = "";
        let downTokenId = "";

        for (let i = 0; i < market.outcomes.length; i++) {
            const outcome = market.outcomes[i]. toLowerCase();
            const price = parseFloat(market.outcomePrices[i] || "0.5");
            const tokenId = market.clobTokenIds[i] || "";

            if (outcome. includes("up") || outcome.includes("yes")) {
                upPrice = price;
                upTokenId = tokenId;
            } else if (outcome.includes("down") || outcome.includes("no")) {
                downPrice = price;
                downTokenId = tokenId;
            }
        }

        // Вычисляем оставшееся время
        const endTime = new Date(market.endDate).getTime();
        const now = Date.now();
        const timeLeftMs = endTime - now;
        const timeLeftMin = Math.floor(timeLeftMs / 60000);
        const timeLeftSec = Math.floor((timeLeftMs % 60000) / 1000);
        const timeLeft = `${timeLeftMin}м ${timeLeftSec}с`;

        return {
            upPrice,
            downPrice,
            found: true,
            question:  market.question,
            endDate: market.endDate,
            timeLeft,
            upTokenId,
            downTokenId,
        };
    }

    async placeBet(
        tokenId: string,
        price: number,
        size: number
    ): Promise<any> {
        if (!this.creds) {
            throw new Error("API ключ не доступен для торговли");
        }

        console.log(`\n📝 Размещаем ставку:`);
        console.log(`   Token ID: ${tokenId. substring(0, 30)}...`);
        console.log(`   Цена: ${price}`);
        console.log(`   Размер: ${size} USDC`);

        const response = await this.clobClient.createAndPostOrder(
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
    private strategy:  ArbitrageStrategy;
    private running = false;
    private lastTradeTime = 0;
    private lastDetailedLog = 0;
    private stats = {
        trades: 0,
        opportunities: 0,
        startTime: Date.now(),
    };

    constructor(private config: BotConfig) {
        this.priceFeed = new BinancePriceFeed();
        this.polymarket = new PolymarketService(config);
        this.strategy = new ArbitrageStrategy(
            this.priceFeed,
            this.polymarket,
            config
        );
    }

    async start(): Promise<void> {
        console. log(`
╔══════════════════════════════════════════════════════════════╗
║     🤖 POLYMARKET BTC 15-MIN ARBITRAGE BOT                   ║
╠══════════════════════════════════════════════════════════════╣
║  Минимальный edge: ${this.config.minEdgePercent}%                                   ║
║  Размер ставки:  $${this.config. betSizeUsdc}                                        ║
║  Окно моментума: ${this.config.momentumWindowSeconds}s                                     ║
║  Используем Gamma API для 15-min рынков                      ║
╚══════════════════════════════════════════════════════════════╝
        `);

        await this.priceFeed.connect();
        await this.polymarket.initialize();

        console.log("⏳ Накапливаем данные о ценах (35 секунд)...");
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

                // Подробный статус каждые 5 секунд
                if (now - this. lastDetailedLog >= 5000) {
                    this. printDetailedStatus(analysis);
                    this.lastDetailedLog = now;
                }

                // Проверяем cooldown
                const timeSinceLastTrade = (now - this.lastTradeTime) / 1000;
                if (timeSinceLastTrade < this.config. cooldownSeconds && this.lastTradeTime > 0) {
                    await this.sleep(1000);
                    continue;
                }

                // Если есть возможность
                if (analysis. shouldTrade) {
                    this.stats.opportunities++;
                    
                    const tokenId = analysis.direction === "UP" 
                        ? analysis.marketPrices.upTokenId 
                        : analysis.marketPrices.downTokenId;

                    console.log(`\n🎯 АРБИТРАЖНАЯ ВОЗМОЖНОСТЬ! `);
                    console.log(`   Направление: ${analysis. direction}`);
                    console.log(`   Edge: ${analysis.edge. toFixed(2)}%`);
                    console.log(`   Наша оценка: ${(analysis.realProbability * 100).toFixed(1)}%`);
                    console.log(`   Цена рынка:  ${(analysis.direction === "UP" ?  analysis.marketPrices.upPrice :  analysis.marketPrices.downPrice) * 100}%`);

                    // РАСКОММЕНТИРУЙТЕ ДЛЯ РЕАЛЬНОЙ ТОРГОВЛИ: 
                    /*
                    if (tokenId) {
                        await this.polymarket. placeBet(
                            tokenId,
                            analysis. direction === "UP" ?  analysis.marketPrices.upPrice + 0.01 : analysis.marketPrices.downPrice + 0.01,
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
            ? (analysis.momentum > 0 ? "📈" : analysis.momentum < 0 ? "📉" : "➡️")
            : "⏳";

        console. log(`
┌─────────────────────────────────────────────────────────────┐
│ ${arrow} BINANCE BTC:   $${analysis.btcPrice?.toFixed(2) || "N/A"}                              
│    Моментум (${this.config.momentumWindowSeconds}s): ${analysis.momentum?. toFixed(4) || "N/A"}%                          
├───────���─────────────────────────────────────────────────────┤
│ 🎰 POLYMARKET:  ${analysis.marketPrices.found ? "✅" : "❌"} ${analysis.marketPrices.question. substring(0, 35)}
│    ⬆️  UP:    ${(analysis.marketPrices.upPrice * 100).toFixed(1)}%                                    
│    ⬇️  DOWN: ${(analysis. marketPrices. downPrice * 100).toFixed(1)}%                                  
│    ⏱️  Осталось: ${analysis.marketPrices.timeLeft || "N/A"}                            
├─────────────────────────────────────────────────────────────┤
│ 🧠 АНАЛИЗ:  ${analysis.direction}                                       
│    Наша оценка:  ${(analysis.realProbability * 100).toFixed(1)}%                              
│    Edge:  ${analysis.edge. toFixed(2)}% ${analysis.shouldTrade ? "🎯 СИГНАЛ!" : ""}                                   
├─────────────────────────────────────────────────────────────┤
│ 📊 Возможностей: ${this.stats.opportunities} | Сделок: ${this.stats.trades}                      
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
