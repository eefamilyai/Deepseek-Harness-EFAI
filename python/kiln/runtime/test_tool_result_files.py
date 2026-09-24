"""Tests for oversized tool-result delivery (spill + upload + text fallback).

Run:  python -m pytest test_tool_result_files.py -q
or:   python test_tool_result_files.py

No network: every uploader here is a stub, so the suite is deterministic and
safe under CI concurrency. The one property asserted throughout is that a
failure anywhere in delivery degrades to inline text and NEVER raises.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import provider_uploads
import tool_result_files



def _text_of(content):
    """The text of a message body, whether it is a string or a parts list."""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content
                   if isinstance(p, dict) and p.get("type") == "text")

def big(prefix="OUTPUT:\n", n=9000):
    return prefix + "x" * n


class SpillTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_oversized_result_becomes_a_stub_and_uploads(self):
        calls = []

        def uploader(name, data):
            calls.append((name, len(data)))
            return "file-abc123"

        msgs = [{"role": "user", "content": big()}]
        out, spilled = tool_result_files.process_messages(
            msgs, uploader=uploader, directory=self.dir,
        )
        self.assertEqual(len(spilled), 1)
        self.assertEqual(spilled[0].file_id, "file-abc123")
        self.assertTrue(out[0]["content"].startswith("OUTPUT:"))
        self.assertIn("file-abc123", out[0]["content"])
        self.assertEqual(calls[0][1], len(big()))

    def test_an_uploaded_result_keeps_no_body_text_in_the_prompt(self):
        # The provider holds the file and the wire copy carries a native file
        # reference, so any body text here is the payload sent twice — and the
        # prompt is the half the model pays tokens for.
        payload = big()
        out, spilled = tool_result_files.process_messages(
            [{"role": "user", "content": payload}],
            uploader=lambda n, d: "file-abc123", directory=self.dir,
        )
        self.assertTrue(spilled[0].uploaded)
        stub = out[0]["content"]
        self.assertNotIn("x" * 100, stub, "body text leaked into the stub")
        self.assertLess(len(stub), 400)

    def test_a_locally_spilled_result_still_shows_its_head(self):
        # Without an upload there is no file reference to lean on, so the head
        # of the body is the model's only look at the content and must stay.
        out, spilled = tool_result_files.process_messages(
            [{"role": "user", "content": big()}], uploader=None, directory=self.dir,
        )
        self.assertFalse(spilled[0].uploaded)
        self.assertIn("x" * 100, out[0]["content"])
        self.assertIn("Full text:", out[0]["content"])

    def test_a_small_result_is_delivered_too(self):
        # There is no size floor: a short result is written out and uploaded just
        # like a large one, so the prompt never carries tool output at all.
        msgs = [{"role": "user", "content": "OUTPUT:\nshort"}]
        out, spilled = tool_result_files.process_messages(
            msgs, uploader=lambda n, d: "file-small", directory=self.dir,
        )
        self.assertEqual(len(spilled), 1)
        self.assertEqual(spilled[0].file_id, "file-small")
        self.assertNotIn("short", out[0]["content"])

    def test_human_message_is_never_touched(self):
        msgs = [{"role": "user", "content": "x" * 9000}]
        out, spilled = tool_result_files.process_messages(
            msgs, uploader=lambda n, d: "file-x", directory=self.dir,
        )
        self.assertEqual(spilled, [])
        self.assertEqual(out[0]["content"], msgs[0]["content"])

    def test_original_list_is_not_mutated(self):
        original = big()
        msgs = [{"role": "user", "content": original}]
        tool_result_files.process_messages(
            msgs, uploader=lambda n, d: "file-x", directory=self.dir,
        )
        self.assertEqual(msgs[0]["content"], original)

    def test_no_uploader_still_spills_to_disk(self):
        out, spilled = tool_result_files.process_messages(
            [{"role": "user", "content": big()}], uploader=None, directory=self.dir,
        )
        self.assertEqual(len(spilled), 1)
        self.assertIsNone(spilled[0].file_id)
        self.assertIn("saved locally", out[0]["content"])
        self.assertTrue(os.path.exists(spilled[0].path))

    def test_raising_uploader_falls_back_to_text(self):
        def boom(name, data):
            raise RuntimeError("endpoint down")

        out, spilled = tool_result_files.process_messages(
            [{"role": "user", "content": big()}], uploader=boom, directory=self.dir,
        )
        self.assertEqual(len(spilled), 1)
        self.assertIsNone(spilled[0].file_id)
        self.assertTrue(out[0]["content"].startswith("OUTPUT:"))

    def test_empty_or_oversized_file_id_is_rejected(self):
        for bad in ("", "   ", None, 123, "z" * 500):
            out, spilled = tool_result_files.process_messages(
                [{"role": "user", "content": big()}],
                uploader=lambda n, d, _b=bad: _b, directory=self.dir,
            )
            self.assertIsNone(spilled[0].file_id)

    def test_unwritable_directory_keeps_inline_text(self):
        msgs = [{"role": "user", "content": big()}]
        out, spilled = tool_result_files.process_messages(
            msgs, uploader=lambda n, d: "file-x",
            directory=os.path.join(self.dir, "nope", "\0bad"),
        )
        self.assertEqual(spilled, [])
        self.assertEqual(out[0]["content"], msgs[0]["content"])

    def test_filename_is_deterministic_and_content_addressed(self):
        a = tool_result_files.safe_filename("bash", "hello")
        b = tool_result_files.safe_filename("bash", "hello")
        c = tool_result_files.safe_filename("bash", "world")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertNotIn("/", a)
        self.assertNotIn("\\", a)


class EndpointTests(unittest.TestCase):
    def test_openai_tries_collection_then_verb(self):
        got = provider_uploads.endpoint_candidates("openai", "https://api.openai.com/v1")
        self.assertEqual(got[0], "https://api.openai.com/v1/files")
        self.assertIn("https://api.openai.com/v1/files/upload", got)

    def test_anthropic_keeps_its_own_v1(self):
        self.assertEqual(
            provider_uploads.endpoint_candidates("anthropic", "https://api.anthropic.com"),
            ["https://api.anthropic.com/v1/files"],
        )

    def test_gemini_does_not_double_the_version_segment(self):
        for base in ("https://generativelanguage.googleapis.com/v1beta",
                     "https://generativelanguage.googleapis.com"):
            got = provider_uploads.endpoint_candidates("gemini", base)
            self.assertEqual(got, ["https://generativelanguage.googleapis.com/upload/v1beta/files"])
            self.assertNotIn("/v1beta/upload/v1beta", got[0])

    def test_unknown_schema_and_empty_base_have_no_candidates(self):
        self.assertEqual(provider_uploads.endpoint_candidates("deepseek-web", "https://x"), [])
        self.assertEqual(provider_uploads.endpoint_candidates("openai", ""), [])

    def test_parse_file_id_shapes(self):
        self.assertEqual(provider_uploads.parse_file_id("openai", {"id": "file-a"}), "file-a")
        self.assertEqual(provider_uploads.parse_file_id("anthropic", {"id": "file_b"}), "file_b")
        self.assertEqual(
            provider_uploads.parse_file_id("gemini", {"file": {"name": "files/c"}}), "files/c")
        for payload in ({}, {"error": {"message": "no"}}, "nope", {"id": ""}):
            self.assertIsNone(provider_uploads.parse_file_id("openai", payload))

    def test_upload_text_never_raises(self):
        self.assertIsNone(provider_uploads.upload_text("deepseek-web", "https://x", "", "a.txt", b"x"))
        self.assertIsNone(provider_uploads.upload_text("openai", "http://127.0.0.1:9/v1", "", "a.txt", b"x"))
        self.assertIsNone(provider_uploads.upload_text("openai", "https://api.openai.com/v1", "", "a.txt", b""))

    def test_multipart_body_encodes_file_and_fields(self):
        body, ctype = provider_uploads.multipart_body("t.txt", b"hi", fields={"purpose": "assistants"})
        self.assertTrue(ctype.startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="purpose"', body)
        self.assertIn(b'filename="t.txt"', body)
        self.assertTrue(body.endswith(b"--\r\n"))


class DeliverGlueTests(unittest.TestCase):
    """The single call every provider adapter makes."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self._real = provider_uploads.upload_text
        self._spill = tool_result_files.default_spill_dir
        tool_result_files.default_spill_dir = lambda root=None: self.dir

    def tearDown(self):
        provider_uploads.upload_text = self._real
        tool_result_files.default_spill_dir = self._spill

    def test_uploaded_result_names_the_provider_id(self):
        provider_uploads.upload_text = lambda *a, **k: "file-42"
        out = provider_uploads.deliver_tool_results(
            [{"role": "user", "content": big()}], "openai", "https://api.openai.com/v1", "k")
        self.assertIn("file-42", _text_of(out[0]["content"]))

    def test_failed_upload_degrades_to_local_text(self):
        provider_uploads.upload_text = lambda *a, **k: None
        out = provider_uploads.deliver_tool_results(
            [{"role": "user", "content": big()}], "anthropic", "https://api.anthropic.com", "k")
        self.assertIn("saved locally", out[0]["content"])

    def test_a_small_result_is_delivered_too(self):
        provider_uploads.upload_text = lambda *a, **k: "file-s"
        out = provider_uploads.deliver_tool_results(
            [{"role": "user", "content": "OUTPUT:\nhi"}], "openai", "https://x/v1", "k")
        self.assertIn("file-s", _text_of(out[0]["content"]))

    def test_never_raises_when_the_spill_module_is_broken(self):
        msgs = [{"role": "user", "content": big()}]
        real = tool_result_files.process_messages
        tool_result_files.process_messages = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.assertIs(provider_uploads.deliver_tool_results(msgs, "openai", "https://x/v1", ""), msgs)
        finally:
            tool_result_files.process_messages = real



class FileReferenceTests(unittest.TestCase):
    """The provider-native part that makes an uploaded file reachable."""

    def test_openai_uses_a_file_part(self):
        import provider_uploads as pu
        self.assertEqual(pu.file_reference("openai", "file-1", "a.txt"),
                         {"type": "file", "file": {"file_id": "file-1"}})

    def test_anthropic_uses_a_document_block(self):
        import provider_uploads as pu
        ref = pu.file_reference("anthropic", "file-2", "a.txt")
        self.assertEqual(ref["type"], "document")
        self.assertEqual(ref["source"], {"type": "file", "file_id": "file-2"})
        self.assertEqual(ref["title"], "a.txt")

    def test_gemini_uses_file_data_with_a_mime_type(self):
        import provider_uploads as pu
        ref = pu.file_reference("gemini", "file-3", "a.txt")
        self.assertEqual(ref["file_data"]["file_uri"], "file-3")
        self.assertTrue(ref["file_data"]["mime_type"])

    def test_unknown_schema_and_missing_id_have_no_reference(self):
        import provider_uploads as pu
        self.assertIsNone(pu.file_reference("nope", "file-4", "a.txt"))
        self.assertIsNone(pu.file_reference("openai", None, "a.txt"))


class AttachReferenceTests(unittest.TestCase):
    """A spilled message gains its provider part; other messages are untouched."""

    def _spill(self):
        import tool_result_files as trf
        rec = trf.SpilledResult(path="/tmp/x", filename="x.txt",
                                chars=10, file_id="file-9")
        return {trf._SPILLED_KEY: rec, "role": "user", "content": "OUTPUT: stub"}

    def test_a_spilled_message_becomes_text_plus_the_file_part(self):
        import provider_uploads as pu
        out = pu._with_reference(self._spill(), "openai")
        self.assertEqual(out["content"][0]["type"], "text")
        self.assertEqual(out["content"][1]["type"], "file")

    def test_the_private_tag_never_reaches_the_payload(self):
        import provider_uploads as pu
        import tool_result_files as trf
        out = pu._with_reference(self._spill(), "openai")
        self.assertNotIn(trf._SPILLED_KEY, out)

    def test_an_unknown_schema_keeps_the_plain_stub(self):
        import provider_uploads as pu
        out = pu._with_reference(self._spill(), "nope")
        self.assertEqual(out["content"], "OUTPUT: stub")

    def test_a_message_without_the_tag_is_returned_as_is(self):
        import provider_uploads as pu
        msg = {"role": "user", "content": "plain"}
        self.assertIs(pu._with_reference(msg, "openai"), msg)


if __name__ == "__main__":

    unittest.main(verbosity=2)
