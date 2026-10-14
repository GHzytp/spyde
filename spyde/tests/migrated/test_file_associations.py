"""
Double-click and "Open with" offer exactly the formats SpyDE opens.

The installer registers file types from ``electron/electron-builder.yml`` (and,
for Windows "Open with", ``electron/build/installer.nsh``), neither of which can
import ``SUPPORTED_EXTS``. A list that lags it means a format the backend opens
that the desktop never offers SpyDE for; a list that leads it means a
double-click that ends in "Unsupported file type".

The split matters as much as the coverage: SpyDE's own formats become the
default app, generic ones (a .tif, a .dm4) must never take the user's default.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from spyde.backend._session_files import SUPPORTED_EXTS, _DIR_DATASET_EXTS

ELECTRON = Path(__file__).resolve().parents[3] / "electron"
BUILDER_YML = ELECTRON / "electron-builder.yml"
INSTALLER_NSH = ELECTRON / "build" / "installer.nsh"

#: Formats SpyDE owns: a double-click opens them in SpyDE.
SPYDE_OWN = {".hspy", ".de5", ".csb"}
#: Directory stores, which no desktop associates as files.
ASSOCIABLE = set(SUPPORTED_EXTS) - set(_DIR_DATASET_EXTS)
GENERIC = ASSOCIABLE - SPYDE_OWN

HOW_TO_ADD = (
    "SUPPORTED_EXTS and the installer's file associations disagree. A new "
    "format needs an entry under mac.fileAssociations in electron-builder.yml "
    "(rank Alternate unless SpyDE owns it), and a generic one also needs "
    "spydeOpenWith/spydeForgetOpenWith lines in build/installer.nsh "
    "(customInstall/customUnInstall); one SpyDE owns goes under "
    "win.fileAssociations instead."
)


def _associations(platform: str) -> dict[str, dict]:
    config = yaml.safe_load(BUILDER_YML.read_text(encoding="utf-8"))
    assert "fileAssociations" not in config, (
        "a top-level fileAssociations applies to every platform; Windows would "
        "make SpyDE the default app for each entry")
    by_ext = {}
    for entry in config[platform]["fileAssociations"]:
        exts = entry["ext"] if isinstance(entry["ext"], list) else [entry["ext"]]
        for ext in exts:
            by_ext["." + ext] = entry
    return by_ext


def _nsh_macro_extensions(macro: str, called: str) -> set[str]:
    source = INSTALLER_NSH.read_text(encoding="utf-8")
    body = re.search(rf"!macro {macro}\b(.*?)!macroend", source, re.S)
    assert body, f"installer.nsh has no {macro} macro"
    return {"." + ext for ext in
            re.findall(rf'!insertmacro {called} "([a-z0-9]+)"', body.group(1))}


class TestFileAssociations:
    def test_the_owned_formats_are_ones_spyde_opens(self):
        assert SPYDE_OWN <= ASSOCIABLE

    def test_macos_offers_every_supported_file_format(self):
        assert set(_associations("mac")) == ASSOCIABLE, HOW_TO_ADD

    def test_macos_takes_the_default_only_for_spyde_formats(self):
        for ext, entry in _associations("mac").items():
            expected = "Owner" if ext in SPYDE_OWN else "Alternate"
            assert entry.get("rank") == expected, (ext, entry)
            assert entry.get("name"), f"{ext} has no type name"

    def test_windows_default_associations_are_spyde_formats_only(self):
        # electron-builder's NSIS association sets the extension's default app.
        windows = _associations("win")
        assert set(windows) == SPYDE_OWN, HOW_TO_ADD
        for ext, entry in windows.items():
            assert entry.get("description"), f"{ext} has no description"

    def test_windows_offers_every_generic_format_under_open_with(self):
        assert _nsh_macro_extensions("customInstall", "spydeOpenWith") == GENERIC, HOW_TO_ADD

    def test_windows_uninstall_forgets_everything_install_registered(self):
        assert (_nsh_macro_extensions("customUnInstall", "spydeForgetOpenWith")
                == _nsh_macro_extensions("customInstall", "spydeOpenWith"))

    def test_open_with_never_writes_an_extension_default(self):
        # `WriteRegStr ... "Software\Classes\.<ext>" ""` is what makes an app
        # the default; Open-with registration must only touch OpenWithProgids.
        source = INSTALLER_NSH.read_text(encoding="utf-8")
        assert not re.search(r'WriteRegStr \S+ "Software\\Classes\\\.[^"\\]*" ""', source)
