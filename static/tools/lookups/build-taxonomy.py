#!/usr/bin/env python3
import sys
from species_lookup_builder import main
if __name__ == "__main__": raise SystemExit(main(["--only", "taxonomy", *sys.argv[1:]]))
