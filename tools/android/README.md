# Fast Android hierarchy dump

This is a minimal legacy UIAutomator test runner for pages whose animation prevents `adb shell uiautomator dump` from reaching its normal idle condition. It sets UIAutomator's wait-for-idle timeout to zero, reads the current active accessibility root, and serializes the public node properties itself. Null children caused by a changing tree are skipped instead of entering the platform dumper's broken NAF check. A null root, traversal limit, attribute failure, or incomplete write deletes the output and emits no success marker. The resulting XML is a point-in-time observation and must still pass the caller's package, SKU, selected-variant and freshness checks.

Traversal is limited to 10,000 nodes and 100 levels. The helper retains text, content description, resource ID, class, package, interaction/state flags, visibility and screen bounds. It creates no second automation connection and invokes no hidden UI interaction method. Legacy `UiAutomatorTestCase` has no public root accessor, so the bootstrap uses the device-verified existing `UiDevice.mUiAutomationBridge` field only when its declared type is exactly `com.android.uiautomator.core.UiAutomatorBridge`. It then invokes only the device-verified zero-argument `getRootInActiveWindow` method whose return type is exactly `AccessibilityNodeInfo`. A null bridge, null root, changed signature, or missing exact path is fatal and never falls back to the platform hierarchy dumper. This narrow read-only bootstrap depends on the legacy framework's internal bridge shape and must be verified again after an Android framework update.

Build locally with the pinned Android 35 SDK and JDK 17 paths:

```sh
tools/android/build-fast-hierarchy-dump.sh
```

The script prints the generated jar path. To run it on a device, the operator can use:

```sh
adb push tools/android/out/hezi-fast-hierarchy-dump.jar /data/local/tmp/hezi-fast-hierarchy-dump.jar
adb shell uiautomator runtest hezi-fast-hierarchy-dump.jar /system/framework/android.test.base.jar /system/framework/android.test.runner.jar -c com.hezi.tools.FastHierarchyDump#testDump -e output hezi-window.xml
# Pull the exact HEZI_UI_DUMP path printed by the test. With the observed launcher:
adb pull /data/local/tmp/local/tmp/hezi-window.xml ./hezi-window.xml
```

`output` is optional and accepts only a simple file name. The test uses `Environment.getDataDirectory()/local/tmp`, creates it, removes any old output, and fails unless a complete, synced, non-empty file exists. Only then does it print `HEZI_UI_DUMP:` with the exact absolute path to pull. Absolute paths and path traversal are rejected. Rebuild rather than editing the generated jar. The build directory and output jar are local artifacts and are not source inputs.
