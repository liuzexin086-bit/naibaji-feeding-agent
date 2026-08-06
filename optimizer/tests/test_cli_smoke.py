import os
import subprocess
import sys
import unittest


class OptimizerCliSmokeTest(unittest.TestCase):
    def test_cli_entries_run_in_smoke_mode(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env = {**os.environ, "NBJ_OPTIMIZER_SMOKE": "1"}
        for script in (
            "farm_tune.py",
            "simulate.py",
            "search.py",
            "calibrate.py",
        ):
            with self.subTest(script=script):
                result = subprocess.run(
                    [sys.executable, os.path.join(root, script)],
                    cwd=root,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    msg=f"{script} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
                )


if __name__ == "__main__":
    unittest.main()
