import os
import sys
import unittest
from unittest.mock import Mock, patch

import requests


def load_pansou_module(test_case: unittest.TestCase):
    try:
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import pansou_client  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised in red phase
        test_case.fail(f"pansou_client module is not implemented yet: {exc}")
    return pansou_client


class PansouClientConfigTests(unittest.TestCase):
    def test_explicit_base_url_takes_priority(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient(base_url="http://explicit.example")

        self.assertEqual(client.base_url, "http://explicit.example")

    def test_env_base_url_is_used_when_constructor_value_missing(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        self.assertEqual(client.base_url, "http://env.example")

    def test_missing_base_url_raises_clear_error(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError) as ctx:
                pansou_client.PansouClient()

        self.assertIn("PANSOU_BASE_URL", str(ctx.exception))


class PansouClientFailureModeTests(unittest.TestCase):
    def test_search_propagates_request_errors(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        client.session.post = Mock(side_effect=requests.exceptions.ConnectionError("boom"))

        with self.assertRaises(requests.exceptions.ConnectionError):
            client.search("太平年")


if __name__ == "__main__":
    unittest.main()
