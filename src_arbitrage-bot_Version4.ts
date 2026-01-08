/**
 * Polymarket BTC 15-minute Arbitrage Bot
 * С отображением сравнения цен Binance vs Polymarket
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
    chainId: Chain;
    privateKey: string;
    funderAddress: string;
    signatureType: 0 | 1;
    minEdgePercent: number;
    betSizeUsdc: number;
    momentumWindowSeconds: number;
    momentumThresholdPercent: number;
    maxOpenPositions: number;
    cooldownSeconds: number;
}

const botConfig: BotConfig = {
    polymarketHost: "https://clob.polymarket.com",
    chainId:  137 as Chain,
    privateKey: process. env.PRIVATE_KEY || "",
    funderAddress: process.env.FUNDER_ADDRESS || "",
    signatureType: 1,
    minEdgePercent:  5. 0,
    betSizeUsdc:  50,
    momentumWindowSeconds: 30,
    momentumThresholdPercent: 0.15,
    maxOpenPositions: 3,
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
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);

            this.ws. on("open", () => {
                console.log("✅ Подключено к Binance WebSocket");
                this.reconnectAttempts = 0;
                resolve();
            });

            this.ws. on("message", (data:  WebSocket.Data) => {
                try {
                    const trade = JSON.parse(data. toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();

                    this.prices.push({ timestamp, price });

                    const cutoff = timestamp - 300000;
                    this. prices = this.prices.filter(p => p.timestamp > cutoff);
                } catch (e) {
                    // Ignore parse errors
                }
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
        if (this.prices.length === 0) return null;
        return this.prices[this.prices.length - 1].price;
    }

    calculateMomentum(windowSeconds: number): number | null {
        if (this.prices. length < 2) return null;

        const currentTime = Date.now();
        const cutoff = currentTime - windowSeconds * 1000;

        const pastPrices = this.prices.filter(p => p.timestamp <= cutoff);
        if (pastPrices.length === 0) return null;

        const pastPrice = pastPrices[pastPrices.length - 1].price;
        const currentPrice = this.prices[this.prices.length - 1].price;

        return ((currentPrice - pastPrice) / pastPrice) * 100;
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ============== POLYMARKET CLIENT ==============

interface BtcMarket {
    conditionId: string;
    question: string;
    tokens: Array<{
        token_id: string;
        outcome:  string;
    }>;
    tickSize: string;
    negRisk: boolean;
}

interface MarketPrices {
    upPrice: number;
    downPrice: number;
    found: boolean;
    question: string;
}

class PolymarketService {
    private client: ClobClient;
    private creds: ApiKeyCreds | null = null;
    private cachedMarket: BtcMarket | null = null;
    private lastMarketFetch:  number = 0;
    private marketCacheDuration:  number = 60000; // 1 минута

    constructor(private config: BotConfig) {
        const signer = new Wallet(config.privateKey);
        this.client = new ClobClient(
            config.polymarketHost,
            config.chainId,
            signer
        );
    }

    async initialize(): Promise<void> {
        console.log("🔑 Инициализация Polymarket клиента...");
        
        try {
            this.creds = await this.client.createOrDeriveApiKey();
        } catch (e) {
            console.log("⚠️ Не удалось получить API ключ, продолжаем с публичным доступом");
        }
        
        if (this.creds) {
            const signer = new Wallet(this.config.privateKey);
            this.client = new ClobClient(
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

    async findBtc15MinMarket(): Promise<BtcMarket | null> {
        // Используем кэш чтобы не делать много запросов
        const now = Date.now();
        if (this.cachedMarket && (now - this.lastMarketFetch) < this.marketCacheDuration) {
            return this. cachedMarket;
        }

        try {
            const response = await this.client.getMarkets();
            const markets:  any[] = (response as any).data || [];

            for (const market of markets) {
                const question = (market.question || "").toLowerCase();
                if (
                    question.includes("bitcoin") &&
                    question. includes("15") &&
                    (question.includes("up") || question.includes("down"))
                ) {
                    this.cachedMarket = {
                        conditionId: market.condition_id,
                        question: market.question,
                        tokens: market. tokens || [],
                        tickSize: market.minimum_tick_size || "0.01",
                        negRisk: market. neg_risk || false,
                    };
                    this.lastMarketFetch = now;
                    return this.cachedMarket;
                }
            }
            return null;
        } catch (error) {
            console.error("Ошибка поиска рынка:", error);
            return null;
        }
    }

    async getMarketPrices(): Promise<MarketPrices> {
        const market = await this.findBtc15MinMarket();
        
        if (!market) {
            return { upPrice: 0. 5, downPrice: 0.5, found: false, question:  "Рынок не найден" };
        }

        let upPrice = 0. 5;
        let downPrice = 0.5;

        for (const token of market.tokens) {
            try {
                const midpoint = await this.client.getMidpoint(token.token_id);
                const price = parseFloat((midpoint as any)?.mid || "0.5");
                
                if (token.outcome. toLowerCase().includes("up") || token.outcome. toLowerCase().includes("yes")) {
                    upPrice = price;
                } else if (token.outcome. toLowerCase().includes("down") || token.outcome.toLowerCase().includes("no")) {
                    downPrice = price;
                }
            } catch (e) {
                // Используем дефолтные значения
            }
        }

        return { upPrice, downPrice, found: true, question: market.question };
    }

    async getMarketPrice(tokenId: string): Promise<number> {
        try {
            const midpoint = await this. client.getMidpoint(tokenId);
            return parseFloat((midpoint as any)?.mid || "0.5");
        } catch {
            return 0.5;
        }
    }

    async placeBet(
        tokenId: string,
        side: "UP" | "DOWN",
        price: number,
        size: number,
        tickSize: string,
        negRisk: boolean
    ): Promise<any> {
        console.log(`\n📝 Размещаем ставку:`);
        console.log(`   Token ID: ${tokenId. substring(0, 20)}...`);
        console.log(`   Направление: ${side}`);
        console.log(`   Цена: ${price}`);
        console.log(`   Размер: ${size} USDC`);

        try {
            const response = await this.client.createAndPostOrder(
                {
                    tokenID: tokenId,
                    price: price,
                    side: Side. BUY,
                    size: size,
                },
                { 
                    tickSize: tickSize as any,
                    negRisk: negRisk 
                },
                OrderType.GTC,
                false,
                false
            );

            console.log(`✅ Ордер размещён: `, response);
            return response;
        } catch (error) {
            console.error(`❌ Ошибка размещения ордера:`, error);
            throw error;
        }
    }
}

// ============== АРБИТРАЖНАЯ СТРАТЕГИЯ ==============

interface ArbitrageOpportunity {
    direction: "UP" | "DOWN";
    tokenId: string;
    realProbability: number;
    marketProbability: number;
    edge: number;
    recommendedPrice: number;
    size: number;
    tickSize: string;
    negRisk:  boolean;
}

interface AnalysisResult {
    momentum: number | null;
    direction: "UP" | "DOWN" | "NEUTRAL";
    realProbability: number;
    marketPrices: MarketPrices;
    edge: number;
    opportunity: ArbitrageOpportunity | null;
}

class ArbitrageStrategy {
    constructor(
        private priceFeed: BinancePriceFeed,
        private polymarket: PolymarketService,
        private config: BotConfig
    ) {}

    private calculateRealProbability(momentum: number): { prob: number; direction: "UP" | "DOWN" | "NEUTRAL" } {
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
        const momentum = this.priceFeed.calculateMomentum(this.config.momentumWindowSeconds);
        const marketPrices = await this. polymarket.getMarketPrices();
        
        if (momentum === null) {
            return {
                momentum: null,
                direction: "NEUTRAL",
                realProbability:  0.5,
                marketPrices,
                edge: 0,
                opportunity:  null
            };
        }

        const { prob:  realProb, direction } = this.calculateRealProbability(momentum);
        
        let marketProb = 0.5;
        if (direction === "UP") {
            marketProb = marketPrices.upPrice;
        } else if (direction === "DOWN") {
            marketProb = marketPrices. downPrice;
        }

        const edge = (realProb - marketProb) * 100;

        let opportunity:  ArbitrageOpportunity | null = null;

        if (edge >= this.config.minEdgePercent && direction !== "NEUTRAL" && marketPrices.found) {
            const market = await this.polymarket.findBtc15MinMarket();
            if (market) {
                const targetToken = market.tokens. find(t => 
                    t. outcome.toLowerCase().includes(direction.toLowerCase())
                );
                
                if (targetToken) {
                    opportunity = {
                        direction,
                        tokenId: targetToken.token_id,
                        realProbability: realProb,
                        marketProbability: marketProb,
                        edge,
                        recommendedPrice: Math.min(marketProb + 0.01, 0.99),
                        size: this.config.betSizeUsdc,
                        tickSize:  market.tickSize,
                        negRisk: market.negRisk,
                    };
                }
            }
        }

        return {
            momentum,
            direction,
            realProbability: realProb,
            marketPrices,
            edge,
            opportunity
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
        this.priceFeed = new BinancePriceFeed();
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
║     🤖 POLYMARKET BTC 15-MIN ARBITRAGE BOT                   ║
╠══════════════════════════════════════════════════════════════╣
║  Минимальный edge: ${this.config.minEdgePercent}%                                   ║
║  Размер ставки:  $${this.config. betSizeUsdc}                                       ║
║  Окно моментума: ${this.config.momentumWindowSeconds}s                                    ║
╚══════════════════════════════════════════════════════════════╝
        `);

        await this.priceFeed.connect();
        await this.polymarket.initialize();

        console.log("⏳ Накапливаем данные о ценах (35 секунд)...");
        await this.sleep(35000);

        console.log("🚀 Бот запущен!  Ищем арбитражные возможности.. .\n");

        this.running = true;
        await this.mainLoop();
    }

    private async mainLoop(): Promise<void> {
        while (this.running) {
            try {
                const btcPrice = this.priceFeed.getCurrentPrice();
                const analysis = await this.strategy.analyze();
                
                // Выводим подробную информацию каждые 10 секунд
                const now = Date.now();
                if (now - this.lastDetailedLog >= 10000) {
                    this. printDetailedStatus(btcPrice, analysis);
                    this. lastDetailedLog = now;
                } else {
                    // Краткий статус
                    if (btcPrice) {
                        const arrow = analysis.momentum !== null 
                            ? (analysis.momentum > 0 ?  "📈" : analysis.momentum < 0 ? "📉" : "➡️")
                            : "⏳";
                        process.stdout.write(
                            `\r${arrow} BTC: $${btcPrice. toFixed(2)} | ` +
                            `PM UP: ${(analysis.marketPrices.upPrice * 100).toFixed(1)}% | ` +
                            `Edge: ${analysis.edge.toFixed(1)}% | ` +
                            `Сделок: ${this.stats.trades}   `
                        );
                    }
                }

                // Проверяем cooldown
                const timeSinceLastTrade = (now - this.lastTradeTime) / 1000;
                if (timeSinceLastTrade < this.config. cooldownSeconds && this.lastTradeTime > 0) {
                    await this.sleep(1000);
                    continue;
                }

                // Если есть возможность
                if (analysis. opportunity) {
                    this.stats.opportunities++;
                    console.log(`\n\n🎯 НАЙДЕНА АРБИТРАЖНАЯ ВОЗМОЖНОСТЬ! `);
                    console.log(`   Направление: ${analysis.opportunity.direction}`);
                    console.log(`   Edge: ${analysis.opportunity.edge.toFixed(2)}%`);
                    console.log(`   Наша оценка: ${(analysis.opportunity.realProbability * 100).toFixed(1)}%`);
                    console. log(`   Цена рынка:  ${(analysis.opportunity.marketProbability * 100).toFixed(1)}%`);
                    console. log(`   Размер ставки:  $${analysis.opportunity. size}`);

                    // РАСКОММЕНТИРУЙТЕ ДЛЯ РЕАЛЬНОЙ ТОРГОВЛИ: 
                    /*
                    await this.polymarket.placeBet(
                        analysis.opportunity. tokenId,
                        analysis.opportunity. direction,
                        analysis. opportunity.recommendedPrice,
                        analysis.opportunity. size,
                        analysis.opportunity.tickSize,
                        analysis.opportunity.negRisk
                    );
                    
                    this.stats.trades++;
                    this.lastTradeTime = Date.now();
                    */

                    console.log("   ⚠️ СИМУЛЯЦИЯ - ордер НЕ размещён\n");
                }

                await this.sleep(1000);
            } catch (error) {
                console.error("\n❌ Ошибка:", error);
                await this.sleep(5000);
            }
        }
    }

    private printDetailedStatus(btcPrice: number | null, analysis: AnalysisResult): void {
        console.log(`\n
┌─────────────────────────────────────────────────────────────┐
│                    📊 СРАВНЕНИЕ ЦЕН                         │
├─────────────────────────────────────────────────────────────┤
│  BINANCE BTC/USDT:      $${btcPrice?. toFixed(2) || "N/A"}                          
│  Моментум (${this.config.momentumWindowSeconds}s):        ${analysis.momentum?.toFixed(4) || "N/A"}%                         
├─────────────────────────────────────────────────────────────┤
│  POLYMARKET:            ${analysis.marketPrices.found ? "✅ Найден" : "❌ Не найден"}                      
│  Рынок:                ${analysis.marketPrices.question. substring(0, 40)}...
│  Цена UP:              ${(analysis.marketPrices.upPrice * 100).toFixed(1)}%                              
│  Цена DOWN:            ${(analysis.marketPrices.downPrice * 100).toFixed(1)}%                            
├─────────────────────────────────────────────────────────────┤
│  АНАЛИЗ:                                                    │
│  Направление:          ${analysis.direction}                                 
│  Наша оценка:           ${(analysis. realProbability * 100).toFixed(1)}%                              
│  Edge:                 ${analysis.edge.toFixed(2)}% ${analysis.edge >= this.config.minEdgePercent ? "🎯 СИГНАЛ!" : ""}                             
├─────────────────────────────────────────────────────────────┤
│  СТАТИСТИКА:                                                │
│  Возможностей:         ${this.stats.opportunities}                                   
│  Сделок:               ${this.stats. trades}                                   
└─────────────────────────────────────────────────────────────┘
        `);
    }

    stop(): void {
        console.log("\n\n🛑 Останавливаем бота...");
        this.running = false;
        this.priceFeed.disconnect();
        this.printStats();
    }

    private printStats(): void {
        const runtime = (Date.now() - this.stats.startTime) / 1000 / 60;
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      📊 ИТОГОВАЯ СТАТИСТИКА                  ║
╠══════════════════════════════════════════════════════════════╣
║  Время работы:  ${runtime.toFixed(1)} минут
║  Всего сделок:  ${this.stats. trades}
║  Найдено возможностей: ${this.stats.opportunities}
╚══════════════════════════════════════════════════════════════╝
        `);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
        bot.stop();
        process.exit(1);
    }
}

main();