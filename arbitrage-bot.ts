/**
 * Polymarket BTC 15-minute Arbitrage Bot
 * 
 * Использует официальный @polymarket/clob-client для взаимодействия с Polymarket
 * и Binance WebSocket для получения цен BTC в реальном времени
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
    // Polymarket
    polymarketHost: string;
    chainId: Chain;
    privateKey: string;
    funderAddress:  string;
    signatureType: 0 | 1; // 0: Browser Wallet, 1: Magic/Email

    // Стратегия
    minEdgePercent: number;       // Минимальное преимущество для входа (%)
    betSizeUsdc: number;          // Размер ставки в USDC
    momentumWindowSeconds: number; // Окно для расчёта моментума
    momentumThresholdPercent: number; // Порог моментума для сигнала
    maxOpenPositions: number;     // Максимум открытых позиций
    cooldownSeconds: number;      // Пауза между сделками
}

const config: BotConfig = {
    polymarketHost: "https://clob.polymarket. com",
    chainId: Chain. POLYGON, // 137 для mainnet
    privateKey: process.env. PRIVATE_KEY || "",
    funderAddress: process.env. FUNDER_ADDRESS || "",
    signatureType: 1, // Magic/Email login

    minEdgePercent: 5. 0,
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
                    const trade = JSON.parse(data.toString());
                    const price = parseFloat(trade.p);
                    const timestamp = Date.now();

                    this.prices.push({ timestamp, price });

                    // Храним только последние 5 минут
                    const cutoff = timestamp - 300_000;
                    this.prices = this. prices.filter(p => p.timestamp > cutoff);
                } catch (e) {
                    // Игнорируем ошибки парсинга
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

// ============== POLYMARKET CLIENT ==============

interface BtcMarket {
    conditionId: string;
    question: string;
    tokens: {
        token_id: string;
        outcome:  string;
    }[];
    tickSize: string;
    negRisk: boolean;
}

class PolymarketService {
    private client: ClobClient;
    private creds: ApiKeyCreds | null = null;

    constructor(private config: BotConfig) {
        const signer = new Wallet(config.privateKey);
        this.client = new ClobClient(
            config. polymarketHost,
            config.chainId,
            signer
        );
    }

    async initialize(): Promise<void> {
        console.log("🔑 Инициализация Polymarket клиента...");
        
        // Создаём или получаем API ключи
        this.creds = await this. client.createOrDeriveApiKey();
        
        // Пересоздаём клиент с учётными данными
        const signer = new Wallet(this.config.privateKey);
        this.client = new ClobClient(
            this.config.polymarketHost,
            this. config.chainId,
            signer,
            this.creds,
            this.config.signatureType,
            this.config.funderAddress
        );

        console.log("✅ Polymarket клиент инициализирован");
    }

    async findBtc15MinMarket(): Promise<BtcMarket | null> {
        try {
            // Получаем список рынков
            const markets = await this.client.getMarkets();

            // Ищем рынок "Bitcoin Up or Down - 15 minute"
            for (const market of markets) {
                const question = market.question?. toLowerCase() || "";
                if (
                    question.includes("bitcoin") &&
                    question. includes("15") &&
                    (question.includes("up") || question.includes("down"))
                ) {
                    return {
                        conditionId: market.condition_id,
                        question: market.question,
                        tokens: market. tokens || [],
                        tickSize: market.minimum_tick_size || "0.01",
                        negRisk: market.neg_risk || false,
                    };
                }
            }
            return null;
        } catch (error) {
            console.error("Ошибка поиска рынка:", error);
            return null;
        }
    }

    async getOrderBook(tokenId: string): Promise<{
        bids:  Array<{ price: string; size: string }>;
        asks: Array<{ price: string; size:  string }>;
    }> {
        return await this.client. getOrderBook(tokenId);
    }

    async getMarketPrice(tokenId: string): Promise<number> {
        try {
            const midpoint = await this.client.getMidpoint(tokenId);
            return parseFloat(midpoint?. mid || "0.5");
        } catch {
            return 0. 5;
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
                OrderType. GTC,
                false, // deferExec
                false  // postOnly
            );

            console.log(`✅ Ордер размещён: `, response);
            return response;
        } catch (error) {
            console. error(`❌ Ошибка размещения ордера:`, error);
            throw error;
        }
    }

    async cancelAllOrders(): Promise<void> {
        try {
            await this.client.cancelAll();
            console. log("🗑️ Все ордера отменены");
        } catch (error) {
            console.error("Ошибка отмены ордеров:", error);
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

class ArbitrageStrategy {
    constructor(
        private priceFeed: BinancePriceFeed,
        private polymarket: PolymarketService,
        private config: BotConfig
    ) {}

    private calculateRealProbability(momentum: number): { prob: number; direction: "UP" | "DOWN" | "NEUTRAL" } {
        const threshold = this.config.momentumThresholdPercent;

        if (momentum > threshold) {
            // Сильный восходящий тренд
            const prob = Math.min(0.85, 0.55 + (momentum / threshold) * 0.15);
            return { prob, direction: "UP" };
        } else if (momentum < -threshold) {
            // Сильный нисходящий тренд
            const prob = Math.min(0.85, 0.55 + (Math.abs(momentum) / threshold) * 0.15);
            return { prob, direction: "DOWN" };
        } else {
            // Нет чёткого сигнала
            return { prob: 0.5, direction: "NEUTRAL" };
        }
    }

    async findOpportunity(): Promise<ArbitrageOpportunity | null> {
        // 1. Получаем моментум с Binance
        const momentum = this.priceFeed.calculateMomentum(
            this.config.momentumWindowSeconds
        );

        if (momentum === null) {
            return null;
        }

        // 2. Рассчитываем реальную вероятность
        const { prob:  realProb, direction } = this.calculateRealProbability(momentum);

        if (direction === "NEUTRAL") {
            return null;
        }

        // 3. Находим рынок BTC 15-min
        const market = await this.polymarket.findBtc15MinMarket();
        if (!market) {
            console.log("⚠️ Рынок BTC 15-min не найден");
            return null;
        }

        // 4. Находим нужный токен (UP или DOWN)
        const targetToken = market.tokens.find(t => 
            t.outcome. toLowerCase().includes(direction.toLowerCase())
        );

        if (!targetToken) {
            return null;
        }

        // 5. Получаем текущую рыночную цену
        const marketProb = await this. polymarket.getMarketPrice(targetToken. token_id);

        // 6. Рассчитываем edge
        const edge = (realProb - marketProb) * 100;

        console.log(`
        === Анализ ===
        BTC моментум: ${momentum. toFixed(4)}%
        Направление: ${direction}
        Реальная вероятность: ${(realProb * 100).toFixed(2)}%
        Рыночная вероятность: ${(marketProb * 100).toFixed(2)}%
        Edge: ${edge.toFixed(2)}%
        `);

        if (edge >= this. config.minEdgePercent) {
            return {
                direction,
                tokenId: targetToken. token_id,
                realProbability: realProb,
                marketProbability: marketProb,
                edge,
                recommendedPrice: Math.min(marketProb + 0.01, 0.99),
                size:  this.config.betSizeUsdc,
                tickSize:  market.tickSize,
                negRisk: market.negRisk,
            };
        }

        return null;
    }
}

// ============== ГЛАВНЫЙ КЛАСС БОТА ==============

class ArbitrageBot {
    private priceFeed: BinancePriceFeed;
    private polymarket: PolymarketService;
    private strategy:  ArbitrageStrategy;
    private running = false;
    private lastTradeTime = 0;
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

        // Подключаемся к сервисам
        await this.priceFeed.connect();
        await this.polymarket.initialize();

        // Ждём накопления данных о ценах
        console.log("⏳ Накапливаем данные о ценах (35 секунд)...");
        await this.sleep(35000);

        console.log("🚀 Бот запущен!  Ищем арбитражные возможности.. .\n");

        this.running = true;
        await this.mainLoop();
    }

    private async mainLoop(): Promise<void> {
        while (this.running) {
            try {
                const currentPrice = this.priceFeed.getCurrentPrice();
                if (currentPrice) {
                    process.stdout.write(
                        `\r💰 BTC:  $${currentPrice. toFixed(2)} | ` +
                        `📊 Сделок: ${this.stats.trades} | ` +
                        `🎯 Возможностей: ${this. stats.opportunities}`
                    );
                }

                // Проверяем cooldown
                const timeSinceLastTrade = (Date.now() - this.lastTradeTime) / 1000;
                if (timeSinceLastTrade < this.config.cooldownSeconds) {
                    await this.sleep(1000);
                    continue;
                }

                // Ищем арбитражную возможность
                const opportunity = await this. strategy.findOpportunity();

                if (opportunity) {
                    this.stats.opportunities++;
                    console.log(`\n\n🎯 НАЙДЕНА ВОЗМОЖНОСТЬ! `);
                    console.log(`   Направление: ${opportunity.direction}`);
                    console. log(`   Edge: ${opportunity.edge. toFixed(2)}%`);
                    console.log(`   Размер: $${opportunity.size}`);

                    // РАСКОММЕНТИРУЙТЕ ДЛЯ РЕАЛЬНОЙ ТОРГОВЛИ: 
                    /*
                    await this.polymarket.placeBet(
                        opportunity.tokenId,
                        opportunity.direction,
                        opportunity. recommendedPrice,
                        opportunity.size,
                        opportunity.tickSize,
                        opportunity.negRisk
                    );
                    
                    this.stats.trades++;
                    this. lastTradeTime = Date.now();
                    */

                    console.log("   ⚠️ Симуляция - ордер НЕ размещён (раскомментируйте код для реальной торговли)\n");
                }

                await this.sleep(1000);
            } catch (error) {
                console.error("\n❌ Ошибка в главном цикле:", error);
                await this.sleep(5000);
            }
        }
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
║                      📊 СТАТИСТИКА                           ║
╠══════════════════════════════════════════════════════════���═══╣
║  Время работы: ${runtime.toFixed(1)} минут
║  Всего сделок:  ${this.stats. trades}
║  Найдено возможностей:  ${this.stats. opportunities}
╚══════════════════════════════════════════════════════════════╝
        `);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============== ЗАПУСК ==============

async function main() {
    const bot = new ArbitrageBot(config);

    // Обработка Ctrl+C
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