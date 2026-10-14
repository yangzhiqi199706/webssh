import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).resolve().parents[1] / 'lib/dcim-settings-worker.py')


class ConfigTests(unittest.TestCase):
    def test_directory_snapshot_detects_change_add_delete_without_secrets(self):
        first = self.worker.snapshot(self.root)
        self.assertNotIn('private', json.dumps(first))
        self.file.write_text('{broken json')
        second = self.worker.snapshot(self.root)
        self.assertNotEqual(first, second)
        extra = self.root / 'new-config.json'
        extra.write_text('{}')
        self.assertIn('new-config.json', self.worker.snapshot(self.root)['versions'])
        extra.unlink()
        self.assertNotIn('new-config.json', self.worker.snapshot(self.root)['versions'])

    def setUp(self):
        self.assertTrue(pathlib.Path(spec.origin).exists(), '配置事务模块尚未实现')
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name) / 'config'
        self.root.mkdir()
        self.file = self.root / 'sms_gateways.json'
        self.file.write_text(json.dumps({'providers': {'demo': {'enabled': True, 'secret_key': 'private', 'timeout_seconds': 10, 'endpoint': 'https://example.com'}}}))

    def test_redaction_save_and_conflict(self):
        item = self.worker.read_file(self.root, 'sms_gateways.json')
        self.assertNotIn('private', json.dumps(item))
        version = item['revision']
        result = self.worker.save_file(self.root, 'sms_gateways.json', version, [{'path': ['providers', 'demo', 'enabled'], 'value': False}])
        self.assertTrue(result['backup'])
        value = json.loads(self.file.read_text())
        self.assertFalse(value['providers']['demo']['enabled'])
        self.assertEqual(value['providers']['demo']['secret_key'], 'private')
        with self.assertRaises(ValueError):
            self.worker.save_file(self.root, 'sms_gateways.json', version, [])

    def test_reject_type_path_and_range(self):
        rev = self.worker.read_file(self.root, 'sms_gateways.json')['revision']
        for change in [{'path': ['providers','demo','enabled'], 'value': 'false'}, {'path': ['missing'], 'value': True}, {'path': ['providers','demo','timeout_seconds'], 'value': -1}]:
            with self.assertRaises(ValueError):
                self.worker.save_file(self.root, 'sms_gateways.json', rev, [change])
        with self.assertRaises(ValueError):
            self.worker.read_file(self.root, '../secret.json')

    def test_readonly_and_empty_secret_preserved(self):
        rev = self.worker.read_file(self.root, 'sms_gateways.json')['revision']
        self.worker.save_file(self.root, 'sms_gateways.json', rev, [{'path': ['providers','demo','secret_key'], 'value': ''}])
        self.assertEqual(json.loads(self.file.read_text())['providers']['demo']['secret_key'], 'private')
        (self.root / 'service_launchers.json').write_text('{"script":"main.py"}')
        with self.assertRaises(ValueError):
            self.worker.save_file(self.root, 'service_launchers.json', '', [])

    def test_failed_transaction_leaves_original_and_unlocks(self):
        original = self.file.read_bytes()
        rev = self.worker.read_file(self.root, 'sms_gateways.json')['revision']
        with self.assertRaises(ValueError):
            self.worker.save_file(self.root, 'sms_gateways.json', rev, [
                {'path':['providers','demo','enabled'], 'value':False},
                {'path':['providers','demo','timeout_seconds'], 'value':'oops'}])
        self.assertEqual(self.file.read_bytes(), original)
        self.worker.save_file(self.root, 'sms_gateways.json', rev, [])


if __name__ == '__main__':
    unittest.main()
