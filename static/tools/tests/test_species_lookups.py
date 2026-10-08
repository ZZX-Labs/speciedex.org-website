from pathlib import Path
import importlib.util

MODULE = Path(__file__).resolve().parents[1] / "lookups" / "species_lookup_builder.py"
spec = importlib.util.spec_from_file_location("species_lookup_builder", MODULE)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)


def test_display_groups_cover_requested_classes():
    cases = [
        ({"class": "Aves"}, "bird"),
        ({"class": "Mammalia"}, "mammal"),
        ({"class": "Reptilia"}, "reptile"),
        ({"class": "Amphibia"}, "amphibian"),
        ({"class": "Actinopterygii"}, "fish"),
        ({"class": "Malacostraca"}, "crustacean"),
        ({"kingdom": "Fungi"}, "fungi"),
        ({"kingdom": "Plantae"}, "plant"),
        ({"domain": "Bacteria"}, "bacteria"),
        ({"domain": "Archaea"}, "archaea"),
    ]
    for taxonomy, expected in cases:
        assert mod.broad_group({}, taxonomy) == expected


def test_iconic_taxon_hint_can_classify_bird():
    record = {"extra": {"iconic_taxon_name": "Aves"}}
    assert mod.broad_group(record, {}) == "bird"


def test_assertion_name_mismatch_is_rejected():
    assertion = {"scientific_name": "Not the same taxon"}
    assert not mod.compatible_name(assertion, "Aramus guarauna", "Aramus guarauna")
