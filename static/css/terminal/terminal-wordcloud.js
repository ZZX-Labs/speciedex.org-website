/*
========================================================================
Speciedex.org
Terminal Word Cloud Visualization
========================================================================
*/

.terminal-visualization-wordcloud,
.terminal-wordcloud,
.terminal-wordcloud-canvas {
    background: transparent;
}

.terminal-visualization-wordcloud {
    min-height: 18rem;
    overflow: hidden;
    position: relative;
    width: 100%;
}

.terminal-wordcloud-canvas {
    display: block;
    height: 100%;
    width: 100%;
}

.terminal-wordcloud-status {
    bottom: 0.45rem;
    color: rgba(238, 247, 200, 0.56);
    font-size: 0.68rem;
    left: 0.55rem;
    pointer-events: none;
    position: absolute;
    z-index: 2;
}

.terminal-splash-wordcloud {
    background: transparent;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    position: absolute;
    z-index: 2;
}

.terminal-splash-wordcloud canvas,
.terminal-splash-wordcloud .terminal-wordcloud-canvas,
.terminal-splash-wordcloud .terminal-visualization-wordcloud {
    background: transparent !important;
    height: 100% !important;
    inset: 0;
    margin: 0;
    padding: 0;
    position: absolute;
    width: 100% !important;
}

.terminal-splash-wordcloud .terminal-wordcloud-status {
    display: none;
}
