# Speciedex.org

**Speciedex Website**
https://speciedex.org

Speciedex.org is the official website of the **Speciedex Project**, an open research and software initiative concerned with biodiversity knowledge, biological taxonomy, conservation, decentralized information infrastructure, geographic and ecological data, machine learning, and durable public access to scientific knowledge.

The project originated as a theoretical concept around **2013** and developed progressively through **2013–2026** into a broader proposed ecosystem consisting of **Speciedex**, **SpeciedexCore**, **SpeciedexExplorer**, and **SpeciedexNet**.

The website is inspired structurally and philosophically by the clarity, accessibility, and open-source presentation of Bitcoin.org while maintaining an independent visual identity, architecture, purpose, and codebase appropriate to the Speciedex ecosystem.

Speciedex explores how open biological knowledge can be organized, verified, distributed, preserved, searched, analyzed, and made resilient through decentralized systems. Bitcoin and the Lightning Network provide foundational economic and payment infrastructure for portions of the broader architecture, while the project also investigates distributed networking, cryptographic verification, open datasets, machine learning, geographic systems, scientific archives, and interoperable biodiversity information.

---

## Project Ecosystem

### Speciedex

**Speciedex** is the primary biodiversity information system and conceptual foundation of the project.

Its purpose is to provide an extensible framework through which biological species, taxonomy, conservation information, ecological observations, geographic information, scientific literature, imagery, media, datasets, and related knowledge can be organized and explored.

Speciedex is intended to complement rather than replace the scientific institutions, taxonomic authorities, conservation organizations, databases, researchers, museums, botanical gardens, universities, archives, and open-data projects upon which biodiversity science depends.

### SpeciedexCore

**SpeciedexCore** is the proposed core software and data-processing layer of the Speciedex ecosystem.

It is intended to provide common data models, indexing systems, validation mechanisms, APIs, synchronization logic, cryptographic verification, dataset processing, taxonomy handling, and other foundational functionality required by Speciedex applications and network services.

### SpeciedexExplorer

**SpeciedexExplorer** is the proposed human-facing exploration and research interface.

It is intended to provide tools for navigating species, taxonomy, conservation status, geographic distributions, observations, scientific records, media, datasets, relationships, and other interconnected biological information.

The Explorer concept emphasizes discoverability: moving from a single organism or taxon outward into the larger network of biological and scientific knowledge associated with it.

### SpeciedexNet

**SpeciedexNet** is the proposed decentralized networking and distribution layer.

Its purpose is to investigate resilient methods for distributing, synchronizing, verifying, preserving, and accessing biodiversity information across independently operated infrastructure.

The architecture may incorporate conventional Internet infrastructure alongside decentralized and peer-to-peer technologies where technically appropriate.

---

## Bitcoin

Bitcoin is an important foundational technology within the broader Speciedex architecture.

Speciedex does not create or require a new cryptocurrency. Where decentralized economic infrastructure is required, the project is designed around **Bitcoin** rather than introducing an unnecessary project-specific token.

Potential applications include donations, infrastructure funding, machine-to-machine payments, data services, micropayments, contributor incentives, archival services, computational resources, and other permissionless payment mechanisms.

Bitcoin provides a globally interoperable monetary network with properties particularly relevant to long-lived decentralized infrastructure: scarcity, censorship resistance, cryptographic ownership, open participation, and independence from a central issuing authority.

---

## Lightning Network

The **Lightning Network** provides a complementary Bitcoin payment layer for applications requiring rapid, inexpensive, high-frequency, or machine-to-machine transactions.

Speciedex research may use Lightning and implementations such as **LND** where small-value or automated Bitcoin payments are technically appropriate.

Bitcoin remains the underlying settlement system. Lightning extends its usefulness for interactive and network-scale applications.

---

## Bitcoin Smart Contracts

The project also investigates Bitcoin-native programmable transaction mechanisms where they provide meaningful technical value.

This may include multisignature arrangements, timelocks, hashed timelock contracts, Lightning payment primitives, escrow structures, cryptographic commitments, and other Bitcoin Script-based mechanisms.

The objective is not to introduce unnecessary blockchain complexity. Bitcoin functionality should be used only where decentralization, verification, settlement, ownership, or economic coordination genuinely benefits from it.

---

## Biodiversity Data

Speciedex is designed around interoperability with the larger biodiversity and scientific-data ecosystem.

Relevant sources, standards, institutions, and projects include organizations and databases such as the **Catalogue of Life**, **GBIF**, **ITIS**, **IUCN Red List**, **IUCN Green Status**, **WoRMS**, **Encyclopedia of Life**, **Wikispecies**, **Wikidata**, **Wikipedia**, **World Flora Online**, **Plants of the World Online**, **Kew Science**, **NCBI Taxonomy**, **BOLD Systems**, **OBIS**, **FishBase**, **SeaLifeBase**, **Paleobiology Database**, **Tree of Life Web Project**, and numerous specialist taxonomic, genomic, ecological, conservation, geographic, museum, university, and governmental datasets.

Each external source remains subject to its own licensing, attribution, citation, redistribution, API, and usage requirements.

The existence of an external dataset within the broader biodiversity information ecosystem does not imply endorsement of or affiliation with Speciedex.

---

## Artificial Intelligence and Machine Learning

Speciedex research includes applications of artificial intelligence and machine learning to biodiversity information.

Potential applications include species identification, computer vision, acoustic identification, taxonomic reconciliation, semantic search, document analysis, metadata extraction, geographic inference, anomaly detection, ecological modeling, conservation research, dataset deduplication, natural-language interfaces, and scientific knowledge retrieval.

AI-generated conclusions should not automatically be treated as authoritative taxonomic or conservation determinations. Scientific provenance, uncertainty, source attribution, reproducibility, and expert review remain essential.

---

## Geographic and Ecological Information

Species do not exist independently of geography.

The Speciedex architecture therefore considers geographic information a fundamental component of biodiversity knowledge.

Relevant information may include occurrence records, habitat, ecosystems, biomes, watersheds, marine regions, protected areas, migration, elevation, depth, climate, environmental conditions, conservation boundaries, historical ranges, and other spatial relationships.

Geographic data may originate from multiple independent sources and may vary substantially in precision, methodology, licensing, age, and reliability.

Sensitive geographic information, particularly information that could facilitate poaching, trafficking, collection, habitat destruction, or disturbance of threatened organisms, may require deliberate reduction in precision or restricted handling.

---

## Conservation

Conservation is a central motivation of the Speciedex Project.

A biodiversity information system should help people understand not merely what a species is, but how it exists within ecosystems, how its status is changing, what pressures affect it, what evidence supports those conclusions, and which organizations or researchers are working to understand and protect it.

Speciedex seeks to make conservation information more discoverable while respecting the authority and methodology of organizations responsible for formal conservation assessments.

---

## Open Knowledge

Speciedex is built around the principle that humanity benefits when scientific and educational knowledge can be preserved and accessed across generations.

Open-source software, open standards, open scientific datasets, public archives, libraries, museums, universities, conservation organizations, researchers, filmmakers, photographers, naturalists, citizen scientists, and volunteers have collectively created an extraordinary body of knowledge about life on Earth.

Speciedex seeks to build upon that tradition while respecting copyright, licensing, attribution, privacy, scientific provenance, ethical research practices, and restrictions associated with sensitive biodiversity information.

---

## Website Architecture

Speciedex.org is designed as a lightweight, modular static website.

The architecture intentionally minimizes unnecessary dependencies and client-side complexity.

The primary stack consists of:

```text
HTML5
CSS3
JavaScript
JSON
NGINX
```

The website does not require a large client-side framework to render its primary interface.

Reusable site components are loaded through HTML partials using `data-include` elements.

Example:

```html
<div data-include="header"></div>
<div data-include="splash"></div>

<main id="main-content">
    ...
</main>

<div data-include="footer"></div>
```

Partial files are stored under:

```text
/_partials/
```

Typical partials include:

```text
header.html
nav.html
splash.html
footer.html
```

The include system loads these components through same-origin HTTP requests.

Because of this architecture, the site should be served through an HTTP server rather than opened directly using `file://`.

---

## JavaScript Architecture

Site pages load a single public JavaScript entry point:

```text
/static/script.js
```

That file acts as the public wrapper and loads:

```text
/static/js/script.js
```

The internal wrapper initializes the modular JavaScript architecture.

Individual functionality is separated into modules under:

```text
/static/js/
```

Modules may include:

```text
includes.js
header.js
splash.js
nav.js
footer.js
data.js
statistics.js
```

Additional modules may be introduced as the project expands.

The intended dependency flow is:

```text
HTML page
    |
    v
/static/script.js
    |
    v
/static/js/script.js
    |
    +--> includes.js
    +--> header.js
    +--> splash.js
    +--> nav.js
    +--> footer.js
    +--> data.js
    +--> statistics.js
    +--> additional modules
```

HTML partials are loaded before modules that depend upon their resulting DOM elements are initialized.

---

## CSS Architecture

The public stylesheet entry point is:

```text
/static/styles.css
```

The CSS architecture is modularized beneath:

```text
/static/css/
```

The stylesheet system includes foundational and component-specific modules such as:

```text
variables.css
colors.css
fonts.css
base.css
layout.css
typography.css
header.css
nav.css
splash.css
sections.css
cards.css
buttons.css
components.css
footer.css
utilities.css
responsive.css
print.css
```

Responsibilities are intentionally separated.

`variables.css` defines global dimensions, spacing, radii, shadows, transitions, component dimensions, breakpoints, and z-index values.

`colors.css` defines the visual palette and color-related design tokens.

`fonts.css` defines font families and typography tokens.

`base.css` provides foundational browser normalization and document-level behavior.

`layout.css` provides reusable layout primitives.

`typography.css` owns detailed textual presentation.

Component stylesheets such as `header.css`, `nav.css`, `splash.css`, `cards.css`, `buttons.css`, and `footer.css` own their respective components.

`responsive.css` provides cross-component responsive behavior without replacing component ownership.

`print.css` provides print-specific presentation.

---

## Visual Design

The Speciedex visual identity uses a dark interface with a biological green primary color.

Primary color:

```text
#c0d674
```

Accent color:

```text
#e6a42b
```

The primary interface typeface is:

```text
IBM Plex Mono
```

Additional project display typography may use locally hosted fonts where licensing permits.

The design emphasizes clarity, restrained visual complexity, readable information density, accessibility, and compatibility across phones, tablets, laptops, desktops, televisions, widescreen displays, and ultrawide displays.

---

## Repository Structure

A representative repository structure is:

```text
speciedex-website/
|
|-- index.html
|-- README.md
|-- LICENSE
|-- robots.txt
|-- sitemap.xml
|-- nginx.conf
|
|-- _partials/
|   |-- header.html
|   |-- nav.html
|   |-- splash.html
|   `-- footer.html
|
|-- static/
|   |-- script.js
|   |-- styles.css
|   |
|   |-- js/
|   |   |-- script.js
|   |   |-- includes.js
|   |   |-- header.js
|   |   |-- splash.js
|   |   |-- nav.js
|   |   |-- footer.js
|   |   |-- data.js
|   |   `-- statistics.js
|   |
|   |-- css/
|   |   |-- variables.css
|   |   |-- colors.css
|   |   |-- fonts.css
|   |   |-- base.css
|   |   |-- layout.css
|   |   |-- typography.css
|   |   |-- header.css
|   |   |-- nav.css
|   |   |-- splash.css
|   |   |-- sections.css
|   |   |-- cards.css
|   |   |-- buttons.css
|   |   |-- components.css
|   |   |-- footer.css
|   |   |-- utilities.css
|   |   |-- responsive.css
|   |   `-- print.css
|   |
|   |-- data/
|   |-- fonts/
|   |-- icons/
|   |-- images/
|   `-- media/
|
|-- about/
|-- bitcoin/
|-- bitcoin-smart-contracts/
|-- contact/
|-- creator/
|-- credits/
|-- donate/
|-- history/
|-- lightning-network/
|-- speciedex/
|-- speciedexcore/
|-- speciedexexplorer/
`-- speciedexnet/
```

The repository structure may evolve as additional documentation, datasets, software releases, APIs, tools, papers, research, and project components are introduced.

---

## Local Development

Clone the repository:

```bash
git clone https://github.com/ZZX-Labs/speciedex-website.git
cd speciedex-website
```

Because Speciedex uses `fetch()` to load HTML partials and data resources, do not simply open `index.html` directly through the filesystem.

Serve the repository through HTTP.

### Python

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

On Windows, depending on the installed Python command:

```bash
python -m http.server 8000
```

or:

```bash
py -m http.server 8000
```

### NGINX

NGINX is the preferred environment for testing behavior closest to the intended production architecture.

Configure the repository as the server document root and start or reload NGINX.

Example:

```nginx
root /path/to/speciedex-website;
index index.html;
```

Then access the configured local hostname or address.

---

## NGINX

The repository includes an `nginx.conf` suitable as a foundation for local and production deployment.

The configuration supports:

```text
Static HTML pages
Clean directory URLs
HTML partial loading
Static CSS and JavaScript modules
JSON data
Images
Fonts
Media
Compression
Caching policies
Security headers
Custom error pages
```

Production deployment should additionally configure TLS, canonical hostname redirects, certificate management, logging policy, backup procedures, monitoring, and any infrastructure-specific security controls.

---

## Search Engine Indexing

During private development or pre-release deployment, the included `robots.txt` may contain:

```text
User-agent: *
Disallow: /
```

This requests that compliant search-engine crawlers avoid crawling the entire site.

`robots.txt` is not an authentication or security mechanism.

Private or sensitive resources must be protected through actual server-side access controls.

When Speciedex is ready for public indexing, `robots.txt`, page-level robots metadata, canonical URLs, and `sitemap.xml` should be updated accordingly.

---

## Data Files

Machine-readable site data is stored beneath:

```text
/static/data/
```

For example:

```text
/static/data/statistics.json
```

JavaScript modules may retrieve these resources asynchronously.

Data files expected to change regularly should generally use short-lived or revalidation-oriented caching rather than long immutable caching.

---

## Accessibility

Speciedex.org aims to maintain accessible semantic HTML and keyboard-compatible navigation.

The site architecture supports practices including:

```text
Semantic document structure
Skip-to-main-content navigation
Keyboard navigation
Visible focus indicators
ARIA state attributes where appropriate
Reduced-motion preferences
Responsive typography
Screen-reader utility classes
Print styles
High-contrast considerations
```

Accessibility should be treated as an ongoing engineering requirement rather than a one-time compliance step.

---

## Privacy

The core website is designed to function without requiring invasive user tracking.

Where analytics, external services, embedded content, APIs, payment infrastructure, or third-party resources are introduced, their privacy implications should be documented and minimized.

The project should prefer local assets and privacy-preserving infrastructure wherever practical.

---

## Security

The website is intentionally designed with a relatively small client-side attack surface.

Security principles include minimizing JavaScript dependencies, avoiding unnecessary frameworks, serving resources from trusted origins, using appropriate HTTP security headers, restricting sensitive server files, validating dynamically loaded resource names, maintaining dependency awareness, and separating public content from administrative infrastructure.

No public-facing configuration should be assumed secure merely because it is absent from navigation.

Secrets, private keys, credentials, API tokens, database files, internal configuration, private datasets, and sensitive research material must never be committed to the public website repository.

---

## Contributions

Speciedex follows open-source development principles.

Contributions may include software improvements, documentation corrections, accessibility improvements, scientific-data integration, taxonomy research, conservation information, testing, security review, translations, design improvements, dataset tooling, geographic systems, machine-learning research, archival work, and related technical or scientific contributions.

Contributors should preserve scientific provenance and comply with applicable licenses, attribution requirements, privacy obligations, conservation safeguards, and project coding conventions.

Before submitting substantial architectural changes, contributors are encouraged to discuss the proposed design so that parallel implementations do not fragment the project unnecessarily.

---

## Development Principles

Speciedex development should favor simple systems over unnecessary abstraction.

The website should remain usable without large JavaScript frameworks.

Progressive enhancement is preferred where practical.

Public information should use durable URLs.

Components should remain modular without introducing unnecessary dependency chains.

Scientific information should preserve provenance.

External datasets should preserve attribution and licensing information.

Sensitive biodiversity information should be handled responsibly.

Bitcoin functionality should use Bitcoin rather than introducing unnecessary tokens.

Decentralization should solve identifiable technical or institutional problems rather than exist merely as a label.

The system should remain understandable enough that independent developers can inspect, reproduce, mirror, maintain, and extend it.

---

## Mirroring and Resilience

A long-term objective of Speciedex is resilience.

Public project resources should be capable of being mirrored across independent infrastructure where licensing and technical constraints permit.

This may include conventional web mirrors, archival copies, decentralized distribution systems, independently operated nodes, and other mechanisms appropriate to the content.

No single server should ultimately represent the sole surviving copy of important open biodiversity knowledge.

---

## Credits and Acknowledgements

Speciedex exists within a much larger history of scientific research, taxonomy, conservation, computing, open-source software, documentary filmmaking, public archives, and decentralized technology.

The project acknowledges the work of biodiversity and conservation institutions including WWF, IUCN and its Red List and Green Status initiatives, Wikispecies, ITIS, WoRMS, Encyclopedia of Life, Catalogue of Life, Tree of Life projects, GBIF, OBIS, Kew and the Royal Botanic Gardens, and the many additional scientific databases, museums, universities, research institutions, field scientists, taxonomists, conservationists, photographers, filmmakers, citizen scientists, and volunteers whose work has documented life on Earth.

The project also acknowledges technologies and communities including Bitcoin, Bitcoin Core, the Lightning Network, LND, Python, Flask, TensorFlow, Linux, VideoLAN, Mozilla, Wikimedia, Wikipedia, Creative Commons, the Internet Archive, Project Gutenberg, Tor, OpenVPN, GnuPG, Hugging Face, OpenAI, and the broader free and open-source software community.

Special recognition is extended to the wildlife filmmakers, conservationists, explorers, researchers, and communicators who made the natural world visible to generations of people, including Dr. Sylvia Earle, the Cousteau Society and Jacques Cousteau's legacy, Sir David Attenborough, Sandesh Kadur, Doug Allan, and the many teams associated with organizations and broadcasters such as the BBC, PBS, NHK, ARTE, Discovery, Animal Planet, NASA, and the Schmidt Ocean Institute.

The project also remembers those whose work and personal sacrifices helped make Bitcoin possible, and recognizes the contributions associated with Hal Finney, Len Sassaman, Adam Back, Nick Szabo, Gavin Andresen, Martti Malmi, Dorian Nakamoto, the wider cypherpunk community, and countless developers and researchers.

Above all, acknowledgement is given to **Satoshi Nakamoto**, whose work demonstrated that decentralized systems could fundamentally alter assumptions about trust, ownership, coordination, and global networks.

The project also thanks **Marty Stouffer** and the countless wildlife filmmakers whose work inspired an early fascination with wildlife, science, exploration, and conservation.

See the dedicated `/credits/` section of Speciedex.org for expanded acknowledgements, source attribution, institutional references, and third-party licensing information.

---

## Creator

Speciedex was conceived and developed by:

**[0xdeadbeef]**
Creator / Founder / Head Developer


Of **ZZX-Labs R&D**, **[0xdeadbeef] Consulting**, & **BitTechIn**


The theoretical origins of Speciedex date to approximately **2013**, with the concept evolving through research, experimentation, software design, biodiversity interests, decentralized systems, Bitcoin, artificial intelligence, and related technical work during the period from **2013 through 2026**.

---

## Project Status

Speciedex is an evolving research and development project.

Documentation, architecture, software, datasets, interfaces, network protocols, APIs, and proposed features may change substantially as development progresses.

Material describing planned functionality should not automatically be interpreted as representing completed, deployed, production-ready, scientifically validated, or operational functionality.

Project documentation should distinguish clearly between:

```text
Conceptual
Experimental
Prototype
Development
Testing
Release Candidate
Production
```

where those distinctions materially affect interpretation.

---

## Disclaimer

Speciedex is not itself a formal taxonomic authority, conservation-status authority, medical authority, veterinary authority, governmental authority, or substitute for primary scientific literature.

Information obtained through Speciedex should be evaluated according to its original source, methodology, date, provenance, and scientific context.

Conservation classifications should be verified against the responsible authority.

Taxonomic classifications may change as scientific understanding develops.

Geographic occurrence data may be incomplete, historical, generalized, inaccurate, or deliberately obscured for conservation reasons.

Automated and AI-assisted outputs may contain errors and should be independently verified where accuracy is consequential.

---

## License

Licensing information for the Speciedex website and project software is provided in the repository's `LICENSE` file.

Third-party datasets, media, fonts, software, APIs, trademarks, documentation, and other external materials remain subject to their respective licenses and rights holders.

A license covering Speciedex source code does not automatically grant rights to independently licensed third-party content referenced, indexed, embedded, linked, or processed by the project.

---

## Repository

GitHub:

```text
https://github.com/ZZX-Labs/speciedex-website
```

Website:

```text
https://speciedex.org
```

---

**Speciedex — indexing life, preserving knowledge, and exploring decentralized infrastructure for biodiversity information.**
