#!/usr/bin/env python3

from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ditfa_package.layout import build_package_dir
from ditfa_package.layout import validate_package_dir
from ditfa_package.targets import PACKAGE_VARIANTS
from ditfa_package.targets import PackageInputs
from ditfa_package.targets import TARGET_SPECS


class PackageLayoutTest(unittest.TestCase):
    def test_app_server_package_places_code_mode_host_beside_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_dir = root / "package"
            package_dir.mkdir()
            inputs = PackageInputs(
                entrypoint_bin=touch_executable(root / "ditfa-app-server"),
                code_mode_host_bin=touch_executable(root / "ditfa-code-mode-host"),
                rg_bin=touch_executable(root / "rg"),
                zsh_bin=None,
                bwrap_bin=touch_executable(root / "bwrap"),
                ditfa_command_runner_bin=None,
                ditfa_windows_sandbox_setup_bin=None,
            )

            build_package_dir(
                package_dir,
                "1.2.3",
                PACKAGE_VARIANTS["ditfa-app-server"],
                TARGET_SPECS["x86_64-unknown-linux-musl"],
                inputs,
            )
            validate_package_dir(
                package_dir,
                PACKAGE_VARIANTS["ditfa-app-server"],
                TARGET_SPECS["x86_64-unknown-linux-musl"],
                include_zsh=False,
            )

            self.assertTrue((package_dir / "bin" / "ditfa-code-mode-host").is_file())


def touch_executable(path: Path) -> Path:
    path.touch(mode=0o755)
    return path


if __name__ == "__main__":
    unittest.main()
