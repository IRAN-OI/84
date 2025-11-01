(() => {
    const DATA_URL = "processed_data_14040730.json";
    const MAX_MARKET_POINTS = 30;
    const TOP_SYMBOL_LIMIT = 10;
    const DEFAULT_MA = 2;

    const NUMBER_FORMAT = new Intl.NumberFormat("fa-IR");
    const DECIMAL_FORMAT = new Intl.NumberFormat("fa-IR", {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
    });

    const CHART_COLORS = Object.freeze({
        buy: "#22c55e",
        sell: "#ef4444",
        net: "#fbbf24",
        ma: "#38bdf8",
        neutral: "#94a3b8"
    });

    const normalizeText = value => {
        if (!value) return "";
        return String(value)
            .trim()
            .replace(/\s+/g, "")
            .replace(/[آإأ]/g, "ا")
            .replace(/ي/g, "ی")
            .replace(/ك/g, "ک")
            .toLowerCase();
    };

    const formatDateLabel = date => {
        if (!date) return "—";
        const normalized = String(date).replace(/\D/g, "");
        if (normalized.length === 8) {
            const year = normalized.slice(0, 4);
            const month = normalized.slice(4, 6);
            const day = normalized.slice(6, 8);
            return `${year}/${month}/${day}`;
        }
        return date;
    };

    const resolveSymbol = item => (item?.symbol ?? item?.ticker ?? item?.Symbol ?? "").trim();
    const resolveRiskBadge = risk => {
        const value = String(risk ?? "").toLowerCase();
        if (!value) return { text: "نامشخص", className: "badge" };
        if (value.includes("low") || value.includes("کم")) {
            return { text: risk, className: "badge low" };
        }
        if (value.includes("high") || value.includes("بالا")) {
            return { text: risk, className: "badge high" };
        }
        if (value.includes("medium") || value.includes("متوسط")) {
            return { text: risk, className: "badge medium" };
        }
        return { text: risk, className: "badge" };
    };

    class DataRepository {
        constructor(url) {
            this.url = url;
            this.byDate = {};
            this.dates = [];
            this.latestDate = null;
            this.raw = null;
        }

        async load() {
            const response = await fetch(this.url, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`خواندن فایل داده با خطا مواجه شد (${response.status})`);
            }
            this.raw = await response.json();
            this.normalize();
        }

        normalize() {
            const result = {};
            const isSymbolRecord = item => {
                if (!item || typeof item !== "object") return false;
                if ("symbol" in item || "ticker" in item) return true;
                if ("buy_diff" in item || "sell_diff" in item || "net_diff" in item) return true;
                if ("volume_7days" in item || "volume_21days" in item) return true;
                return false;
            };

            const addRecord = (dateInput, record) => {
                if (!record) return;
                let date = dateInput ?? record.trade_date ?? record.date ?? record.snapshot_date ?? record.last_date;
                if (!date) return;
                date = String(date).replace(/\D/g, "");
                if (!date) return;
                if (date.length !== 8) return;
                if (!result[date]) {
                    result[date] = [];
                }
                result[date].push(record);
            };

            const walker = (node, hintedDate = null) => {
                if (!node) return;
                if (Array.isArray(node)) {
                    node.forEach(item => walker(item, hintedDate));
                    return;
                }
                if (typeof node !== "object") return;

                if (isSymbolRecord(node)) {
                    addRecord(hintedDate, node);
                    return;
                }

                for (const [key, value] of Object.entries(node)) {
                    if (key === "history") continue;
                    const dateLike = /^\d{8}$/.test(key) ? key : hintedDate;
                    walker(value, dateLike);
                }
            };

            walker(this.raw);

            this.dates = Object.keys(result).sort();
            this.byDate = result;
            this.latestDate = this.dates[this.dates.length - 1] ?? null;
        }

        getRecords(date) {
            return this.byDate[date] ?? [];
        }

        getLatestRecords() {
            return this.latestDate ? [...this.getRecords(this.latestDate)] : [];
        }

        computeMarketSeries() {
            return this.dates.map(date => {
                const records = this.getRecords(date);
                if (!records.length) {
                    return {
                        date,
                        buy: 0,
                        sell: 0,
                        net: 0,
                        volume: 0,
                        symbols: 0,
                        filtered: 0
                    };
                }

                let weightedBuy = 0;
                let weightedSell = 0;
                let weightedNet = 0;
                let totalWeight = 0;
                let volumeSum = 0;
                let filteredCount = 0;

                records.forEach(item => {
                    const volume =
                        Number(item.volume_7days ?? item.volume7 ?? item.volume ?? item.volume_weight ?? 0) || 0;
                    const weight = volume > 0 ? volume : 1;
                    const buy = Number(item.buy_diff ?? item.buyOI ?? item.buy_ratio ?? 0) || 0;
                    const sell = Number(item.sell_diff ?? item.sellOI ?? item.sell_ratio ?? 0) || 0;
                    const net = Number(item.net_diff ?? item.netOI ?? buy - sell) || 0;

                    weightedBuy += buy * weight;
                    weightedSell += sell * weight;
                    weightedNet += net * weight;
                    totalWeight += weight;
                    volumeSum += Math.max(volume, 0);

                    const pmRatio = Number(item.pm_ratio ?? 0);
                    const monthlyVolume = Number(item.monthly_volume ?? item.volume_21days ?? 0);
                    if (pmRatio || monthlyVolume) {
                        filteredCount += 1;
                    }
                });

                const divisor = totalWeight || records.length || 1;
                return {
                    date,
                    buy: weightedBuy / divisor,
                    sell: weightedSell / divisor,
                    net: weightedNet / divisor,
                    volume: volumeSum,
                    symbols: records.length,
                    filtered: filteredCount || records.length
                };
            });
        }

        getSymbolHistory(symbol) {
            const normalized = normalizeText(symbol);
            if (!normalized) return [];

            const timeline = [];
            const seen = new Set();

            for (const date of this.dates) {
                const records = this.getRecords(date);
                const match = records.find(rec => normalizeText(resolveSymbol(rec)) === normalized);
                if (!match) continue;

                if (Array.isArray(match.history) && match.history.length) {
                    match.history.forEach(entry => {
                        const historyDate = entry.date ?? entry.trade_date ?? entry.snapshot_date ?? date;
                        const key = `${historyDate}-${entry.buy_diff ?? entry.net_diff ?? ""}`;
                        if (seen.has(key)) return;
                        seen.add(key);
                        timeline.push({
                            date: historyDate,
                            buy: Number(entry.buy_diff ?? entry.buyOI ?? entry.buy_ratio ?? 0) || 0,
                            sell: Number(entry.sell_diff ?? entry.sellOI ?? entry.sell_ratio ?? 0) || 0,
                            net: Number(entry.net_diff ?? entry.netOI ?? 0) || 0,
                            volume7: Number(entry.volume_7days ?? entry.volume7 ?? 0) || 0,
                            volume21: Number(entry.volume_21days ?? entry.volume21 ?? 0) || 0
                        });
                    });
                } else {
                    const key = `${date}-${match.buy_diff ?? match.net_diff ?? ""}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    timeline.push({
                        date,
                        buy: Number(match.buy_diff ?? match.buyOI ?? match.buy_ratio ?? 0) || 0,
                        sell: Number(match.sell_diff ?? match.sellOI ?? match.sell_ratio ?? 0) || 0,
                        net: Number(match.net_diff ?? match.netOI ?? (match.buy_diff ?? 0) - (match.sell_diff ?? 0)) || 0,
                        volume7: Number(match.volume_7days ?? match.volume7 ?? match.volume ?? 0) || 0,
                        volume21: Number(match.volume_21days ?? match.volume21 ?? 0) || 0
                    });
                }
            }

            const sorted = timeline.sort((a, b) =>
                String(a.date).localeCompare(String(b.date))
            );
            return sorted;
        }
    }

    class TabController {
        constructor(onChange) {
            this.buttons = Array.from(document.querySelectorAll("[data-tab-button]"));
            this.panels = Array.from(document.querySelectorAll("[data-tab-panel]"));
            this.onChange = onChange;
        }

        init() {
            if (!this.buttons.length || !this.panels.length) return;

            this.buttons.forEach(button => {
                button.addEventListener("click", () => this.activate(button.dataset.tabButton));
            });

            const initial = this.buttons.find(btn => btn.classList.contains("is-active"));
            const initialId = initial ? initial.dataset.tabButton : this.buttons[0].dataset.tabButton;
            this.activate(initialId);
        }

        activate(targetId) {
            this.buttons.forEach(button => {
                const isActive = button.dataset.tabButton === targetId;
                button.classList.toggle("is-active", isActive);
                button.setAttribute("aria-selected", isActive ? "true" : "false");
            });

            this.panels.forEach(panel => {
                const isActive = panel.dataset.tabPanel === targetId;
                panel.classList.toggle("is-active", isActive);
            });

            if (typeof this.onChange === "function") {
                this.onChange(targetId);
            }
        }
    }

    class MarketView {
        constructor(repository) {
            this.repository = repository;
            this.chart = null;
            this.series = [];
            this.elements = {
                buyValue: document.getElementById("marketBuyValue"),
                buyChange: document.getElementById("marketBuyChange"),
                sellValue: document.getElementById("marketSellValue"),
                sellChange: document.getElementById("marketSellChange"),
                netValue: document.getElementById("marketNetValue"),
                netChange: document.getElementById("marketNetChange"),
                trendLabel: document.getElementById("marketTrendLabel"),
                trendWindow: document.getElementById("marketWindow"),
                filtered: document.getElementById("marketFiltered"),
                volumeValue: document.getElementById("marketVolumeValue"),
                volumeChange: document.getElementById("marketVolumeChange"),
                symbolCount: document.getElementById("marketSymbolCount"),
                dateCount: document.getElementById("marketDateCount"),
                lastUpdate: document.getElementById("marketLastUpdate")
            };
        }

        init() {
            this.series = this.repository.computeMarketSeries();
            if (!this.series.length) {
                this.showPlaceholder("marketChart", "هیچ داده‌ای برای ترسیم نمودار کل بازار یافت نشد.");
                return;
            }
            this.renderStats();
            this.renderChart();
        }

        renderStats() {
            const current = this.series[this.series.length - 1];
            const previous = this.series.length > 1 ? this.series[this.series.length - 2] : null;

            this.updateValue(this.elements.buyValue, current.buy);
            this.updateChange(this.elements.buyChange, current.buy, previous?.buy);

            this.updateValue(this.elements.sellValue, current.sell);
            this.updateChange(this.elements.sellChange, current.sell, previous?.sell);

            this.updateValue(this.elements.netValue, current.net);
            this.updateChange(this.elements.netChange, current.net, previous?.net);

            this.elements.trendLabel.textContent =
                current.net > 0 ? "خروج پول هوشمند" : current.net < 0 ? "ورود پول هوشمند" : "خنثی";
            this.elements.trendLabel.style.color =
                current.net < 0 ? CHART_COLORS.buy : current.net > 0 ? CHART_COLORS.sell : CHART_COLORS.neutral;

            this.elements.trendWindow.textContent = NUMBER_FORMAT.format(Math.min(this.series.length, MAX_MARKET_POINTS));
            this.elements.filtered.textContent = NUMBER_FORMAT.format(current.filtered);

            this.elements.volumeValue.textContent = NUMBER_FORMAT.format(Math.round(current.volume));
            this.updateChange(this.elements.volumeChange, current.volume, previous?.volume, true);

            this.elements.symbolCount.textContent = `${NUMBER_FORMAT.format(current.symbols)} نماد`;
            this.elements.dateCount.textContent = NUMBER_FORMAT.format(this.series.length);
            this.elements.lastUpdate.textContent = formatDateLabel(this.repository.latestDate);
        }

        updateValue(target, value) {
            if (!target) return;
            target.textContent = DECIMAL_FORMAT.format(Number(value) || 0);
            target.classList.toggle("positive", value < 0);
            target.classList.toggle("negative", value > 0 && target === this.elements.sellValue);
        }

        updateChange(target, current, previous, isInteger = false) {
            if (!target) return;
            if (previous == null || Number.isNaN(previous)) {
                target.textContent = "—";
                target.className = "stat-change";
                return;
            }

            const diff = current - previous;
            const percent = previous === 0 ? 0 : (diff / Math.abs(previous)) * 100;
            const formatter = isInteger ? NUMBER_FORMAT : DECIMAL_FORMAT;
            const symbol = diff >= 0 ? "▲" : "▼";

            target.textContent = `${symbol} ${formatter.format(diff)} (${percent.toFixed(1)}٪)`;
            target.className = `stat-change ${diff > 0 ? "positive" : diff < 0 ? "negative" : ""}`;
        }

        renderChart() {
            const canvas = document.getElementById("marketChart");
            if (!canvas) return;

            const limitedSeries = this.series.slice(-MAX_MARKET_POINTS);
            const labels = limitedSeries.map(item => formatDateLabel(item.date));
            const netData = limitedSeries.map(item => item.net);
            const buyData = limitedSeries.map(item => item.buy);
            const sellData = limitedSeries.map(item => item.sell);

            this.destroyChart();

            const context = canvas.getContext("2d");
            const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
            gradient.addColorStop(0, "rgba(34, 197, 94, 0.35)");
            gradient.addColorStop(0.5, "rgba(15, 23, 42, 0.15)");
            gradient.addColorStop(1, "rgba(239, 68, 68, 0.35)");

            this.chart = new Chart(context, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            type: "bar",
                            label: "خالص OI",
                            data: netData,
                            backgroundColor: ctx => (ctx.raw ?? 0) < 0 ? CHART_COLORS.buy : CHART_COLORS.sell,
                            borderRadius: 6,
                            borderSkipped: false,
                            borderWidth: 1,
                            borderColor: "rgba(15, 23, 42, 0.6)"
                        },
                        {
                            type: "line",
                            label: "OI خرید",
                            data: buyData,
                            tension: 0.35,
                            fill: false,
                            borderColor: CHART_COLORS.buy,
                            borderWidth: 2,
                            pointRadius: 3
                        },
                        {
                            type: "line",
                            label: "OI فروش",
                            data: sellData,
                            tension: 0.35,
                            fill: false,
                            borderColor: CHART_COLORS.sell,
                            borderWidth: 2,
                            pointRadius: 3
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: "nearest",
                        intersect: false
                    },
                    scales: {
                        x: {
                            grid: {
                                color: "rgba(148, 163, 184, 0.08)"
                            },
                            ticks: {
                                color: "#cbd5f5"
                            }
                        },
                        y: {
                            grid: {
                                color: "rgba(148, 163, 184, 0.05)"
                            },
                            ticks: {
                                color: "#cbd5f5",
                                callback: value => DECIMAL_FORMAT.format(value)
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            labels: {
                                color: "#d1d8f4"
                            }
                        },
                        tooltip: {
                            backgroundColor: "rgba(11, 18, 36, 0.92)",
                            borderColor: "rgba(148, 163, 184, 0.3)",
                            borderWidth: 1,
                            padding: 12,
                            titleColor: "#f8fafc",
                            bodyColor: "#e2e8f0",
                            callbacks: {
                                label: context => {
                                    const label = context.dataset.label || "";
                                    const value = context.parsed.y ?? context.parsed;
                                    return `${label}: ${DECIMAL_FORMAT.format(value)}`;
                                }
                            }
                        }
                    }
                }
            });
        }

        destroyChart() {
            if (this.chart) {
                this.chart.destroy();
                this.chart = null;
            }
        }

        resize() {
            if (this.chart) {
                this.chart.resize();
            }
        }

        showPlaceholder(canvasId, message) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const parent = canvas.parentElement;
            parent.innerHTML = `<div class="empty-state">${message}</div>`;
        }
    }

    class SymbolView {
        constructor(repository) {
            this.repository = repository;
            this.symbols = [];
            this.filteredSymbols = [];
            this.currentSymbol = null;
            this.currentMA = DEFAULT_MA;
            this.chart = null;

            this.elements = {
                tableBody: document.getElementById("symbolTableBody"),
                totalCount: document.getElementById("symbolTotalCount"),
                displayedCount: document.getElementById("symbolDisplayedCount"),
                searchInput: document.getElementById("symbolSearchInput"),
                chartCanvas: document.getElementById("symbolChart"),
                chartTitle: document.getElementById("symbolChartTitle"),
                chartStatus: document.getElementById("symbolChartStatus"),
                maChips: Array.from(document.querySelectorAll(".ma-chip")),
                summary: {
                    net: document.getElementById("symbolNetAvg"),
                    buy: document.getElementById("symbolBuyAvg"),
                    sell: document.getElementById("symbolSellAvg"),
                    volume7: document.getElementById("symbolVolume7Avg"),
                    volume21: document.getElementById("symbolVolume21Avg"),
                    latestDate: document.getElementById("symbolLatestDate"),
                    details: document.getElementById("symbolDetailsList")
                }
            };
        }

        init() {
            this.symbols = this.repository.getLatestRecords();
            this.filteredSymbols = [...this.symbols];
            this.updateCounters();

            this.bindEvents();
            this.renderTable();

            if (this.filteredSymbols.length) {
                this.handleSymbolSelect(resolveSymbol(this.filteredSymbols[0]));
            } else {
                this.showChartPlaceholder("برای مشاهده نمودار، نمادی با دادهٔ معتبر در فایل وجود ندارد.");
            }
        }

        bindEvents() {
            if (this.elements.searchInput) {
                this.elements.searchInput.addEventListener("input", event => {
                    const query = normalizeText(event.target.value ?? "");
                    this.filterSymbols(query);
                });
            }

            this.elements.maChips.forEach(chip => {
                chip.addEventListener("click", () => {
                    const period = Number(chip.dataset.ma) || DEFAULT_MA;
                    if (period === this.currentMA) return;

                    this.currentMA = period;
                    this.elements.maChips.forEach(btn => btn.classList.toggle("is-active", btn === chip));
                    if (this.currentSymbol) {
                        this.updateChart();
                    }
                });
            });
        }

        filterSymbols(query) {
            if (!query) {
                this.filteredSymbols = [...this.symbols];
            } else {
                this.filteredSymbols = this.symbols.filter(item =>
                    normalizeText(resolveSymbol(item)).includes(query)
                );
            }

            this.renderTable();
            this.updateCounters();

            if (this.currentSymbol) {
                const stillVisible = this.filteredSymbols.some(
                    item => normalizeText(resolveSymbol(item)) === normalizeText(this.currentSymbol)
                );
                if (!stillVisible) {
                    this.currentSymbol = null;
                    this.showChartPlaceholder("نماد انتخابی در فیلتر فعلی وجود ندارد.");
                    this.resetSummary();
                }
            }
        }

        updateCounters() {
            if (this.elements.totalCount) {
                this.elements.totalCount.textContent = NUMBER_FORMAT.format(this.symbols.length);
            }
            if (this.elements.displayedCount) {
                this.elements.displayedCount.textContent = NUMBER_FORMAT.format(this.filteredSymbols.length);
            }
        }

        renderTable() {
            if (!this.elements.tableBody) return;

            if (!this.filteredSymbols.length) {
                this.elements.tableBody.innerHTML = `
                    <tr>
                        <td colspan="6">نمادی مطابق جست‌وجوی شما یافت نشد.</td>
                    </tr>
                `;
                return;
            }

            this.elements.tableBody.innerHTML = this.filteredSymbols
                .map(item => {
                    const symbol = resolveSymbol(item) || "—";
                    const pm = item.pm_ratio != null ? Number(item.pm_ratio).toFixed(2) : "—";
                    const diff = item.first_ceiling_diff_percent != null
                        ? `${Number(item.first_ceiling_diff_percent).toFixed(2)}٪`
                        : "—";
                    const risk = resolveRiskBadge(item.risk_level ?? item.risk);
                    const volume7 = NUMBER_FORMAT.format(Math.round(Number(item.volume_7days ?? 0)));
                    const volume21 = NUMBER_FORMAT.format(Math.round(Number(item.volume_21days ?? 0)));

                    return `
                        <tr data-symbol="${symbol}">
                            <td>${symbol}</td>
                            <td>${pm}</td>
                            <td>${diff}</td>
                            <td><span class="${risk.className}">${risk.text}</span></td>
                            <td>${volume7}</td>
                            <td>${volume21}</td>
                        </tr>
                    `;
                })
                .join("");

            Array.from(this.elements.tableBody.querySelectorAll("tr")).forEach(row => {
                row.addEventListener("click", () => {
                    const symbol = row.getAttribute("data-symbol");
                    this.handleSymbolSelect(symbol);
                });
            });

            this.highlightActiveRow();
        }

        handleSymbolSelect(symbol) {
            if (!symbol) return;

            this.currentSymbol = symbol;
            this.highlightActiveRow();

            if (this.elements.chartTitle) {
                this.elements.chartTitle.textContent = `نمودار OI نماد ${symbol}`;
            }
            if (this.elements.chartStatus) {
                this.elements.chartStatus.textContent = "داده‌ها در حال بارگذاری هستند...";
            }

            this.updateChart();
            this.updateSummary();
        }

        highlightActiveRow() {
            const rows = Array.from(this.elements.tableBody?.querySelectorAll("tr") ?? []);
            rows.forEach(row =>
                row.classList.toggle(
                    "is-active",
                    normalizeText(row.dataset.symbol) === normalizeText(this.currentSymbol)
                )
            );
        }

        updateChart() {
            if (!this.elements.chartCanvas) return;

            const history = this.repository.getSymbolHistory(this.currentSymbol);
            if (!history.length) {
                this.showChartPlaceholder("برای این نماد تاریخچهٔ کافی در فایل داده وجود ندارد.");
                this.resetSummary();
                return;
            }

            const labels = history.map(item => formatDateLabel(item.date));
            const buyData = history.map(item => item.buy);
            const sellData = history.map(item => item.sell);
            const netData = history.map(item => item.net);
            const maData = this.calculateMovingAverage(netData, this.currentMA);

            this.destroyChart();

            const ctx = this.elements.chartCanvas.getContext("2d");
            this.chart = new Chart(ctx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            type: "bar",
                            label: "OI خریداران",
                            data: buyData,
                            backgroundColor: "rgba(34, 197, 94, 0.55)",
                            borderRadius: 5,
                            borderWidth: 1,
                            borderColor: "rgba(34, 197, 94, 0.4)"
                        },
                        {
                            type: "bar",
                            label: "OI فروشندگان",
                            data: sellData,
                            backgroundColor: "rgba(239, 68, 68, 0.55)",
                            borderRadius: 5,
                            borderWidth: 1,
                            borderColor: "rgba(239, 68, 68, 0.4)"
                        },
                        {
                            type: "line",
                            label: "خالص OI",
                            data: netData,
                            borderColor: CHART_COLORS.net,
                            borderWidth: 2,
                            tension: 0.35,
                            pointRadius: 3,
                            fill: false
                        },
                        {
                            type: "line",
                            label: `میانگین ${this.currentMA} روزه`,
                            data: maData,
                            borderColor: CHART_COLORS.ma,
                            borderDash: [6, 4],
                            borderWidth: 2,
                            tension: 0.25,
                            pointRadius: 0,
                            fill: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: "index",
                        intersect: false
                    },
                    scales: {
                        x: {
                            stacked: false,
                            grid: {
                                color: "rgba(148, 163, 184, 0.08)"
                            },
                            ticks: {
                                color: "#d1d8f4",
                                autoSkip: true,
                                maxRotation: 0
                            }
                        },
                        y: {
                            stacked: false,
                            grid: {
                                color: "rgba(148, 163, 184, 0.08)"
                            },
                            ticks: {
                                color: "#d1d8f4",
                                callback: value => DECIMAL_FORMAT.format(value)
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            labels: {
                                color: "#d1d8f4"
                            }
                        },
                        tooltip: {
                            backgroundColor: "rgba(11, 18, 36, 0.92)",
                            borderColor: "rgba(148, 163, 184, 0.3)",
                            borderWidth: 1,
                            padding: 12,
                            callbacks: {
                                label: context => {
                                    const value = context.parsed.y ?? context.parsed;
                                    const label = context.dataset.label;
                                    return `${label}: ${DECIMAL_FORMAT.format(value)}`;
                                }
                            }
                        }
                    }
                }
            });

            if (this.elements.chartStatus) {
                this.elements.chartStatus.textContent = `${history.length} رکورد برای ${this.currentSymbol}`;
            }
        }

        calculateMovingAverage(values, period) {
            const output = [];
            for (let i = 0; i < values.length; i += 1) {
                if (i < period - 1) {
                    output.push(null);
                    continue;
                }
                const windowValues = values.slice(i - period + 1, i + 1);
                const sum = windowValues.reduce((total, value) => total + (value ?? 0), 0);
                output.push(sum / period);
            }
            return output;
        }

        destroyChart() {
            if (this.chart) {
                this.chart.destroy();
                this.chart = null;
            }
        }

        updateSummary() {
            const history = this.repository.getSymbolHistory(this.currentSymbol);
            if (!history.length) {
                this.resetSummary();
                return;
            }

            const latest = history[history.length - 1];
            const netAvg = history.reduce((sum, item) => sum + item.net, 0) / history.length;
            const buyAvg = history.reduce((sum, item) => sum + item.buy, 0) / history.length;
            const sellAvg = history.reduce((sum, item) => sum + item.sell, 0) / history.length;
            const volume7Avg = history.reduce((sum, item) => sum + item.volume7, 0) / history.length;
            const volume21Avg = history.reduce((sum, item) => sum + item.volume21, 0) / history.length;

            this.elements.summary.net.textContent = DECIMAL_FORMAT.format(netAvg);
            this.elements.summary.buy.textContent = DECIMAL_FORMAT.format(buyAvg);
            this.elements.summary.sell.textContent = DECIMAL_FORMAT.format(sellAvg);
            this.elements.summary.volume7.textContent = NUMBER_FORMAT.format(Math.round(volume7Avg));
            this.elements.summary.volume21.textContent = NUMBER_FORMAT.format(Math.round(volume21Avg));
            this.elements.summary.latestDate.textContent = formatDateLabel(latest.date);

            const latestRecord = this.symbols.find(
                item => normalizeText(resolveSymbol(item)) === normalizeText(this.currentSymbol)
            );

            if (!latestRecord) {
                this.elements.summary.details.innerHTML = "<p>اطلاعات تکمیلی در فایل داده موجود نیست.</p>";
                return;
            }

            const infoMap = [
                ["P/M", latestRecord.pm_ratio != null ? Number(latestRecord.pm_ratio).toFixed(2) : "—"],
                ["اختلاف سقف اول", latestRecord.first_ceiling_diff_percent != null
                    ? `${Number(latestRecord.first_ceiling_diff_percent).toFixed(2)}٪`
                    : "—"
                ],
                ["ریسک", latestRecord.risk_level ?? latestRecord.risk ?? "—"],
                ["حجم امروز", NUMBER_FORMAT.format(Math.round(Number(latestRecord.volume ?? 0)))],
                ["ورود پول حقیقی", DECIMAL_FORMAT.format(Number(latestRecord.real_money_flow ?? 0))],
                ["قدرت خریدار", DECIMAL_FORMAT.format(Number(latestRecord.buy_ratio ?? 0))]
            ];

            this.elements.summary.details.innerHTML = `
                <dl>
                    ${infoMap
                        .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`)
                        .join("")}
                </dl>
            `;
        }

        resetSummary() {
            this.elements.summary.net.textContent = "0.000";
            this.elements.summary.buy.textContent = "0.000";
            this.elements.summary.sell.textContent = "0.000";
            this.elements.summary.volume7.textContent = "0";
            this.elements.summary.volume21.textContent = "0";
            this.elements.summary.latestDate.textContent = "—";
            this.elements.summary.details.innerHTML = "<p>نمادی انتخاب نشده است.</p>";
        }

        showChartPlaceholder(message) {
            const canvas = this.elements.chartCanvas;
            if (!canvas) return;
            const parent = canvas.parentElement;
            parent.innerHTML = `<div class="empty-state">${message}</div>`;
        }
    }

    class TopSymbolsView {
        constructor(repository) {
            this.repository = repository;
            this.chart = null;
        }

        init() {
            const records = this.repository.getLatestRecords();
            const dateLabel = document.getElementById("topSymbolsDate");
            if (dateLabel) {
                dateLabel.textContent = formatDateLabel(this.repository.latestDate);
            }

            if (!records.length) {
                this.showPlaceholder("topVolumeChart", "برای رسم نمودار ۱۰ نماد پرحجم، داده‌ای موجود نیست.");
                return;
            }

            const sorted = records
                .filter(item => Number(item.volume_7days ?? item.volume ?? 0) > 0)
                .sort((a, b) => (Number(b.volume_7days ?? b.volume ?? 0) || 0) - (Number(a.volume_7days ?? a.volume ?? 0) || 0))
                .slice(0, TOP_SYMBOL_LIMIT);

            if (!sorted.length) {
                this.showPlaceholder("topVolumeChart", "هیچ نمادی شرایط حجم موثر را نداشت.");
                return;
            }

