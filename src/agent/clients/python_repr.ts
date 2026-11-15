// Python's own text of a value (CPython 3.12: str(), repr(), bytes.decode), where it reaches what PEAR's model
// client raises. The OpenAI SDK that pear/deploy/station/agent_loop/clients/vllm.py drives writes a refusal as
// f"Error code: {status} - {body}", with the decoded JSON body as Python prints it, and PEAR's agent loop shows the
// message of whatever ended a turn to the model in the next one.
//
// It is with the rest of what pear.js reproduces of Python, in src/python/repr.ts; this file gives it under the
// client's path.

export {
  isPythonPrintable,
  plainOf,
  pythonDecodeUtf8,
  pythonJsonDecode,
  pythonRepr,
  pythonStr,
  pythonStringRepr,
  pythonTruth,
  pythonTypeName,
  pythonValueOf,
  type JsonValue,
} from "../../python/repr";
