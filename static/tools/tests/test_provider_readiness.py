"""Prevent false healthy maintenance status when providers were not observed."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from providers.readiness import check_scan

TOOLS = Path(__file__).resolve().parents[1]


def load_tool(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('bad', [None, {'error': 'upstream failure'}, {'status': 'cooldown'},
                                {'rejected': 1}, {'fetched': -1}, {'status': 'blocked'}])
def test_partial_or_failed_scan_cannot_pass(bad):
    definitions = [{'name': 'one'}, {'name': 'two'}]
    good = {'provider': 'one', 'fetched': 2, 'rejected': 0, 'error': None}
    second = [] if bad is None else [{**good, 'provider': 'two', **bad}]
    assert not check_scan(definitions, {'providers': [good, *second]})['all_operational']
    assert check_scan(definitions, {'providers': [good, {**good, 'provider': 'two'}]})['all_operational']
    assert not check_scan(definitions, {'providers': [good, good]})['all_operational']


@pytest.mark.parametrize('age,rejected,accepted', [('current', 0, True), ('stale', 0, False), ('current', 1, False)])
def test_host_requires_current_successful_ingestion(tmp_path, monkeypatch, age, rejected, accepted):
    maintenance = load_tool('maintain-speciedex.py')
    registry = tmp_path / 'static/tools/providers.json'
    registry.parent.mkdir(parents=True)
    registry.write_text(json.dumps({'providers': [{'name': 'one'}]}))
    report = tmp_path / 'static/data/statistics-sources.json'
    report.parent.mkdir(parents=True)
    monkeypatch.setattr(maintenance, 'availability', lambda *args: (True, ''))

    def run(arguments, **kwargs):
        if 'scan' in arguments:
            report.write_text(json.dumps({'generated_at': maintenance.stamp() if age == 'current' else '2000-01-01T00:00:00Z',
                                          'providers': [{'provider': 'one', 'fetched': 2, 'rejected': rejected, 'error': None}]}))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(maintenance.subprocess, 'run', run)
    result = maintenance.cycle(tmp_path, rebuild=False)
    assert result['all_operational'] is accepted
    assert result['status'] == ('completed' if accepted else 'degraded')


def test_probe_with_rejected_rows_fails(tmp_path, monkeypatch):
    livecheck = load_tool('provider-livecheck.py')
    monkeypatch.setattr(livecheck, 'prerequisites', lambda *args: (True, []))
    provider = SimpleNamespace(fetch=lambda: SimpleNamespace(records=[object()], raw=2, requests=0,
                              exhausted=True, next_cursor=None, rejected=[{'reason': 'missing name'}]))
    monkeypatch.setattr(livecheck, 'load_provider', lambda *args: provider)
    result = livecheck.run_one(tmp_path, {'name': 'one'}, timeout=1, retries=1, batch_size=2)
    assert result['status'] == 'failed' and result['rejected'] == 1
