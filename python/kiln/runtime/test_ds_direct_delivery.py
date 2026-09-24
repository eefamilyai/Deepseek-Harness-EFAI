"""File delivery of oversized tool results from the DeepSeek-direct adapter.

`ds_direct` owns the clip that the model actually feels, so these cover the
contract of the glue that replaced the clip: an oversized result becomes a
file-backed stub, and every failure path keeps the inline text.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ds_direct  # noqa: E402



def _text_of(content):
    """The text of a message body, whether it is a string or a parts list."""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content
                   if isinstance(p, dict) and p.get("type") == "text")

def big(n=20000):
    return "OUTPUT:\n" + ("a line of tool output\n" * (n // 21))


class FakeClient:
    def __init__(self, ret="file-abc", raises=False):
        self.calls = []
        self.ret = ret
        self.raises = raises

    def upload_file(self, filename, blob):
        self.calls.append((filename, len(blob)))
        if self.raises:
            raise RuntimeError("upload endpoint is down")
        return self.ret


class DeliverToolResultsTests(unittest.TestCase):
    def test_oversized_result_becomes_a_stub_and_uploads(self):
        c = FakeClient()
        msgs = [{"role": "user", "content": big()}]
        out, ids = ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(len(out), 1)
        self.assertLess(len(_text_of(out[0]["content"])), 6000)
        self.assertTrue(c.calls, "upload_file was never called")
        self.assertIn("file-abc", _text_of(out[0]["content"]))

    def test_a_small_result_is_uploaded_too(self):
        c = FakeClient()
        msgs = [{"role": "user", "content": "OUTPUT:\nsmall"}]
        out, ids = ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(ids, ["file-abc"])
        self.assertTrue(c.calls, "a small result was not uploaded")

    def test_upload_failure_degrades_to_the_local_file(self):
        c = FakeClient(raises=True)
        msgs = [{"role": "user", "content": big()}]
        out, ids = ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(len(out), 1)
        self.assertLess(len(_text_of(out[0]["content"])), 6000)
        self.assertNotIn("file-abc", _text_of(out[0]["content"]))

    def test_provider_without_a_file_id_still_spills_to_disk(self):
        c = FakeClient(ret=None)
        msgs = [{"role": "user", "content": big()}]
        out, ids = ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(len(out), 1)
        self.assertLess(len(_text_of(out[0]["content"])), 6000)
        self.assertNotIn("file-abc", _text_of(out[0]["content"]))

    def test_a_result_is_uploaded_once_across_repeated_turns(self):
        c = FakeClient()
        msgs = [{"role": "user", "content": big()}]
        ds_direct._deliver_tool_results(c, msgs)
        ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(len(c.calls), 1, "the same bytes were uploaded twice")

    def test_the_uploaded_id_is_returned_for_the_completion(self):
        c = FakeClient()
        msgs = [{"role": "user", "content": big()}]
        _, ids = ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(ids, ["file-abc"],
                         "the id must reach ref_file_ids or the model cannot "
                         "open the file it was handed a stub for")

    def test_the_durable_list_is_not_mutated(self):
        c = FakeClient()
        msgs = [{"role": "user", "content": big()}]
        before = msgs[0]["content"]
        ds_direct._deliver_tool_results(c, msgs)
        self.assertEqual(msgs[0]["content"], before)



class ClipSpillTests(unittest.TestCase):
    """A result cut by the total-budget clip is still fully retrievable."""

    def setUp(self):
        import tempfile
        import tool_result_files as trf
        self.dir = tempfile.mkdtemp()
        self._orig = trf.default_spill_dir
        trf.default_spill_dir = lambda root=None: self.dir

    def tearDown(self):
        import tool_result_files as trf
        trf.default_spill_dir = self._orig

    def test_a_clipped_result_is_written_out_and_named(self):
        import glob as _glob
        body = "OUTPUT:\n" + ("line of output here\n" * 2000)
        out = ds_direct._truncate_tool_result({"role": "user", "content": body}, 500)
        self.assertLess(len(out["content"]), len(body))
        self.assertIn("full text:", out["content"])
        files = _glob.glob(os.path.join(self.dir, "*.txt"))
        self.assertEqual(len(files), 1)
        self.assertEqual(open(files[0], encoding="utf-8").read(), body)

    def test_a_result_that_fits_is_returned_untouched(self):
        msg = {"role": "user", "content": "OUTPUT:\nsmall"}
        self.assertIs(ds_direct._truncate_tool_result(msg, 500), msg)

    def test_an_unwritable_spill_directory_still_clips(self):
        import tool_result_files as trf
        # A path whose "directory" is an existing FILE cannot be created, on
        # any platform — unlike a missing absolute path, which Windows will
        # happily mkdir at the drive root.
        blocker = os.path.join(self.dir, "not-a-directory")
        with open(blocker, "w", encoding="utf-8") as fh:
            fh.write("x")
        trf.default_spill_dir = lambda root=None: os.path.join(blocker, "sub")
        body = "OUTPUT:\n" + ("x\n" * 2000)
        out = ds_direct._truncate_tool_result({"role": "user", "content": body}, 500)
        self.assertLess(len(out["content"]), len(body))
        self.assertNotIn("full text:", out["content"])


if __name__ == "__main__":
    unittest.main()
