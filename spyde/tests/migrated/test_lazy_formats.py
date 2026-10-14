"""
Every extension SpyDE opens is opened LAZILY, through ``load_aligned``, so a
format belongs in ``SUPPORTED_EXTS`` only if its reader leaves the pixels on
disk until a frame is asked for. A reader that accepts ``lazy=True`` and reads
the whole file anyway would put a multi-GB scan in RAM at open.

The test that matters is behavioural: open the file, then overwrite its bytes
with zeros, then read a frame. A reader that kept the data on disk returns the
zeros; one that read everything at open still returns the original pixels.
(``.emd`` keeps its HDF5 file open, which Windows will not let us overwrite, so
it is checked by what the lazy array wraps instead.)

The DigitalMicrograph, Merlin and Velox fixtures under ``data/lazy_formats``
are from the RosettaSciIO test suite (GPL-3.0):
``digitalmicrograph/3D/test-1.dm4``,
``quantumdetector/Merlin_navigation4x2_signalNx256_ROI.zip`` and
``emd/velox_emd_v11_elementSelection.zip``. None of the three formats has a
writer to make one here.
"""
from __future__ import annotations

import os
import re
import shutil
import zipfile
from pathlib import Path

import numpy as np
import pytest

from spyde.backend._session_files import (
    SELF_DESCRIBING_EXTS, SUPPORTED_EXTS, FileLoaderMixin,
)

DATA = Path(__file__).parent / "data" / "lazy_formats"
INDEX_TS = Path(__file__).resolve().parents[3] / "electron" / "src" / "main" / "index.ts"


@pytest.fixture(scope="module", autouse=True)
def _readers_patched():
    """The format patches in spyde.external must be in place before a load,
    exactly as the app's load path ensures."""
    from spyde.backend.heavy_imports import ensure_heavy_imports
    ensure_heavy_imports()


def _load(path):
    signal = FileLoaderMixin.load_aligned(str(path))
    return signal[0] if isinstance(signal, list) else signal


def _frames(shape, dtype):
    return np.random.default_rng(0).integers(1, 200, shape).astype(dtype)


def _zero_file(path) -> None:
    """Overwrite every byte in place, keeping the length (no truncation)."""
    size = os.path.getsize(path)
    with open(path, "r+b") as handle:
        handle.write(b"\0" * size)
        handle.flush()


def _first_frame(signal):
    index = (0,) * signal.axes_manager.navigation_dimension
    return np.asarray(signal.data[index].compute())


def _assert_whole_frame_chunks(signal):
    """The signal axes are never split across chunks (CLAUDE.md Live-Display §1)."""
    n_signal = signal.axes_manager.signal_dimension
    shape = signal.data.shape[-n_signal:]
    chunks = signal.data.chunksize[-n_signal:]
    assert chunks == shape, f"signal axes split: chunks {chunks} of {shape}"


# ── the files ──────────────────────────────────────────────────────────────────

def _blockfile(tmp_path):
    import hyperspy.api as hs
    path = tmp_path / "scan.blo"
    hs.signals.Signal2D(_frames((6, 5, 32, 32), np.uint8)).save(path)
    return path


def _ripple(tmp_path):
    import hyperspy.api as hs
    path = tmp_path / "stack.rpl"
    hs.signals.Signal2D(_frames((7, 32, 32), np.uint16)).save(path)
    return path


def _digital_micrograph(tmp_path):
    path = tmp_path / "stack.dm4"
    shutil.copy(DATA / "stack_2x2x2.dm4", path)
    return path


def _merlin(tmp_path):
    with zipfile.ZipFile(DATA / "merlin_nav4x2.zip") as archive:
        archive.extractall(tmp_path)
    return next(tmp_path.glob("003_*.mib"))


#: (builder, file whose bytes hold the pixels — the .raw beside a .rpl)
ON_DISK = {
    ".blo": (_blockfile, None),
    ".rpl": (_ripple, ".raw"),
    ".dm4": (_digital_micrograph, None),
    ".mib": (_merlin, None),
}


class TestTheListIsLazy:
    @pytest.mark.parametrize("ext", sorted(ON_DISK))
    def test_pixels_are_read_from_disk_when_a_frame_is_asked_for(self, ext,
                                                                 tmp_path):
        build, pixel_ext = ON_DISK[ext]
        path = build(tmp_path)
        signal = _load(path)
        assert hasattr(signal.data, "dask"), f"{ext} did not open lazily"
        assert np.any(_first_frame(signal)), "the fixture's first frame is blank"

        pixels = path.with_suffix(pixel_ext) if pixel_ext else path
        _zero_file(pixels)
        assert not np.any(_first_frame(signal)), (
            f"{ext}: the frame still has its old pixels after the file was "
            "zeroed, so the reader read the whole file at open")

    @pytest.mark.parametrize("ext", sorted(ON_DISK))
    def test_frames_are_never_split_across_chunks(self, ext, tmp_path):
        build, _ = ON_DISK[ext]
        _assert_whole_frame_chunks(_load(build(tmp_path)))

    def test_emd_wraps_the_stored_dataset_not_a_copy(self, tmp_path):
        """The upstream EMD reader reads the whole dataset even when lazy;
        spyde.external's patch hands dask the HDF5 dataset itself."""
        import hyperspy.api as hs
        path = tmp_path / "scan.emd"
        hs.signals.Signal2D(_frames((6, 5, 32, 32), np.uint16)).save(path)
        signal = _load(path)
        assert hasattr(signal.data, "dask")
        wrapped = [v for v in dict(signal.data.dask).values()
                   if isinstance(v, np.ndarray) and not isinstance(v, np.memmap)
                   and v.nbytes >= signal.data.nbytes]
        assert not wrapped, "the lazy .emd array wraps an in-memory copy"
        assert np.any(_first_frame(signal))

    def test_a_velox_eds_spectrum_image_opens_lazily(self, tmp_path):
        """Velox stores an EDS spectrum image as an event stream. RosettaSciIO
        reads the stream (the compact form) at open and builds the dense cube
        chunk by chunk, so the cube itself must never be held in memory; this
        needs the ``sparse`` package, which is why it is a dependency."""
        with zipfile.ZipFile(DATA / "velox_eds_si.zip") as archive:
            archive.extractall(tmp_path)
        path = next(tmp_path.glob("*.emd"))
        signals = FileLoaderMixin.load_aligned(str(path))
        signals = signals if isinstance(signals, list) else [signals]
        cubes = [s for s in signals if s.axes_manager.navigation_dimension == 2
                 and s.axes_manager.signal_dimension == 1]
        assert len(cubes) == 1, "no spectrum image among the signals read"
        cube = cubes[0]
        assert hasattr(cube.data, "dask")
        assert cube.metadata.get_item("Signal.signal_type") == "EDS_TEM"
        _assert_whole_frame_chunks(cube)
        held = [v for v in dict(cube.data.dask).values()
                if isinstance(v, np.ndarray) and v.nbytes >= cube.data.nbytes]
        assert not held, "the dense spectrum image is held in memory"
        spectrum = np.asarray(cube.data[0, 0].compute())
        assert spectrum.shape == cube.axes_manager.signal_shape[::-1]

    def test_every_listed_extension_is_covered_here_or_was_before(self):
        """A new extension must come with a laziness test. The original seven
        have their own suites (test_zspy_load, test_csb_reader, the MRC and
        TIFF loaders)."""
        tested = set(ON_DISK) | {".dm3", ".emd"}
        original = {".hspy", ".zspy", ".mrc", ".tif", ".tiff", ".de5", ".csb"}
        assert set(SUPPORTED_EXTS) <= tested | original


class TestTheSelfDescribingOnesSkipThePrompt:
    def test_a_calibrated_scan_does_not_ask_for_its_shape(self):
        for ext in (".dm3", ".dm4", ".emd", ".blo", ".rpl", ".hspy", ".zspy"):
            assert FileLoaderMixin._is_self_describing(f"scan{ext}"), ext

    def test_a_flat_stack_still_asks(self):
        for ext in (".mrc", ".tif", ".mib"):
            assert not FileLoaderMixin._is_self_describing(f"scan{ext}"), ext

    def test_self_describing_is_a_subset_of_what_opens(self):
        assert set(SELF_DESCRIBING_EXTS) - {".zarr"} <= set(SUPPORTED_EXTS)


class TestTheOpenDialogOffersThem:
    """The Open dialog's filter lists live in the Electron main process; one
    that lags SUPPORTED_EXTS silently hides a format the backend would open."""

    def test_both_em_data_filters_list_every_supported_extension(self):
        source = INDEX_TS.read_text(encoding="utf-8")
        lists = re.findall(r"name: 'EM Data', extensions: \[([^\]]*)\]", source)
        assert len(lists) == 2, "expected the File menu and the open-file IPC dialog"
        expected = {e.lstrip(".") for e in SUPPORTED_EXTS}
        for listed in lists:
            exts = set(re.findall(r"'([a-z0-9]+)'", listed))
            assert exts == expected, f"dialog {sorted(exts)} vs backend {sorted(expected)}"
