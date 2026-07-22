/*
========================================================================
Speciedex.org
Terminal Word Cloud Visualization
========================================================================

Canvas-based, continuously updating word cloud for scientific names, common
names, ranks, habitats, providers, and geographic terms.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "WordCloud";

    function resolveCanvas(target) {
        if (target instanceof HTMLCanvasElement) {
            return target;
        }

        if (target instanceof Element) {
            return (
                target.querySelector("canvas") ||
                target.appendChild(
                    document.createElement("canvas")
                )
            );
        }

        throw new TypeError(
            "WordCloud requires a canvas or container element."
        );
    }

    function normalizeWords(input) {
        const values =
            typeof input === "function"
                ? input()
                : input;

        const counts =
            new Map();

        for (const item of values || []) {
            if (
                item === null ||
                item === undefined
            ) {
                continue;
            }

            if (
                typeof item === "object"
            ) {
                const candidates = [
                    item.scientific_name,
                    item.scientificName,
                    item.common_name,
                    item.commonName,
                    item.rank,
                    item.country,
                    item.habitat,
                    item.provider
                ];

                for (const candidate of candidates) {
                    if (!candidate) {
                        continue;
                    }

                    const word =
                        String(candidate)
                            .trim();

                    counts.set(
                        word,
                        (counts.get(word) || 0) + 1
                    );
                }

                continue;
            }

            const word =
                String(item).trim();

            if (word) {
                counts.set(
                    word,
                    (counts.get(word) || 0) + 1
                );
            }
        }

        return [...counts.entries()]
            .map(([text, weight]) => ({
                text,
                weight
            }))
            .sort(
                (left, right) =>
                    right.weight -
                    left.weight ||
                    left.text.localeCompare(
                        right.text
                    )
            );
    }

    class WordCloudController {
        constructor(target, options = {}) {
            this.canvas =
                resolveCanvas(target);

            this.context =
                this.canvas.getContext("2d", {
                    alpha: true,
                    desynchronized: true
                });

            this.options = {
                source:
                    options.source || [],
                maxWords:
                    Number(options.maxWords) || 28,
                minFont:
                    Number(options.minFont) || 10,
                maxFont:
                    Number(options.maxFont) || 28,
                refresh:
                    Number(options.refresh) || 900,
                opacity:
                    Number(options.opacity) || 0.34,
                rotation:
                    Number(options.rotation) || 0.08,
                ...options
            };

            this.words = [];
            this.running = false;
            this.destroyed = false;
            this.timer = 0;
            this.resizeObserver = null;

            this.installResize();
            this.refresh();
        }

        installResize() {
            const resize = () => {
                const rect =
                    this.canvas.getBoundingClientRect();

                const ratio =
                    Math.min(
                        window.devicePixelRatio || 1,
                        2
                    );

                this.canvas.width =
                    Math.max(
                        1,
                        Math.floor(
                            rect.width * ratio
                        )
                    );

                this.canvas.height =
                    Math.max(
                        1,
                        Math.floor(
                            rect.height * ratio
                        )
                    );

                this.context.setTransform(
                    ratio,
                    0,
                    0,
                    ratio,
                    0,
                    0
                );

                this.draw();
            };

            if ("ResizeObserver" in window) {
                this.resizeObserver =
                    new ResizeObserver(resize);

                this.resizeObserver.observe(
                    this.canvas
                );
            } else {
                window.addEventListener(
                    "resize",
                    resize
                );
            }

            resize();
        }

        refresh() {
            this.words =
                normalizeWords(
                    this.options.source
                ).slice(
                    0,
                    this.options.maxWords
                );

            this.draw();
        }

        draw() {
            if (this.destroyed) {
                return;
            }

            const width =
                this.canvas.clientWidth;

            const height =
                this.canvas.clientHeight;

            this.context.clearRect(
                0,
                0,
                width,
                height
            );

            if (!this.words.length) {
                return;
            }

            const maxWeight =
                Math.max(
                    1,
                    ...this.words.map(
                        word =>
                            word.weight
                    )
                );

            const centerX =
                width / 2;

            const centerY =
                height / 2;

            this.words.forEach(
                (word, index) => {
                    const ratio =
                        word.weight /
                        maxWeight;

                    const fontSize =
                        this.options.minFont +
                        ratio *
                        (
                            this.options.maxFont -
                            this.options.minFont
                        );

                    const angle =
                        index *
                        2.399963229728653;

                    const radius =
                        8 +
                        Math.sqrt(index) *
                        Math.min(
                            26,
                            Math.max(
                                10,
                                width / 22
                            )
                        );

                    const x =
                        centerX +
                        Math.cos(angle) *
                        radius;

                    const y =
                        centerY +
                        Math.sin(angle) *
                        radius *
                        0.62;

                    this.context.save();
                    this.context.translate(
                        x,
                        y
                    );

                    this.context.rotate(
                        index % 7 === 0
                            ? this.options.rotation
                            : 0
                    );

                    this.context.font =
                        `${fontSize}px monospace`;

                    this.context.textAlign =
                        "center";

                    this.context.textBaseline =
                        "middle";

                    this.context.fillStyle =
                        `rgba(192, 214, 116, ${
                            Math.min(
                                0.82,
                                this.options.opacity +
                                ratio * 0.22
                            )
                        })`;

                    this.context.fillText(
                        word.text,
                        0,
                        0
                    );

                    this.context.restore();
                }
            );
        }

        push(value) {
            const current =
                typeof this.options.source ===
                "function"
                    ? normalizeWords(
                        this.options.source
                    ).map(
                        item => item.text
                    )
                    : Array.from(
                        this.options.source || []
                    );

            current.push(value);
            this.options.source =
                current;

            this.refresh();
        }

        start() {
            if (this.running || this.destroyed) {
                return;
            }

            this.running = true;

            this.timer =
                window.setInterval(
                    () => this.refresh(),
                    this.options.refresh
                );
        }

        stop() {
            this.running = false;

            if (this.timer) {
                window.clearInterval(
                    this.timer
                );
            }
        }

        update(options = {}) {
            Object.assign(
                this.options,
                options
            );

            this.refresh();
        }

        destroy() {
            this.stop();
            this.resizeObserver?.
                disconnect();

            this.destroyed = true;
        }
    }

    function mount(target, options = {}) {
        const controller =
            new WordCloudController(
                target,
                options
            );

        controller.start();

        return controller;
    }

    function render(data = [], options = {}) {
        const container =
            document.createElement("section");

        container.className =
            "terminal-visualization terminal-visualization-wordcloud";

        const canvas =
            document.createElement("canvas");

        container.appendChild(canvas);

        const controller =
            mount(canvas, {
                source: data,
                ...options
            });

        container.controller =
            controller;

        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context) {
        const visualization = {
            mount,
            render,
            Controller:
                WordCloudController
        };

        context.registerVisualization?.(
            "wordcloud",
            visualization
        );

        context.registerRenderer?.(
            "wordcloud",
            visualization
        );

        context.wordcloud =
            visualization;

        return visualization;
    }

    const commands = [
        {
            name: "wordcloud",
            category: "visualization",
            description:
                "Render a word cloud from a terminal library collection.",
            usage: "wordcloud [collection]",
            handler: ({
                args,
                context
            }) => {
                const collection =
                    args[0] || "records";

                const data =
                    context.library?.
                        get?.(collection) || [];

                return render(
                    data,
                    {
                        label:
                            `Word cloud for ${collection}`
                    }
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        WordCloudController,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalWordCloud =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
