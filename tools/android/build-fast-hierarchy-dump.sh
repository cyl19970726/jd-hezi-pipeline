#!/bin/sh
set -eu

SDK_PLATFORM=${ANDROID_PLATFORM_DIR:-/Users/hhh0x/Library/Android/sdk/platforms/android-35}
D8=${ANDROID_D8:-/Users/hhh0x/Library/Android/sdk/build-tools/35.0.0/d8}
JDK_BIN=${JAVA17_BIN:-/opt/homebrew/opt/openjdk@17/bin}
JDK_HOME=${JAVA17_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_DIR="$SCRIPT_DIR/.build-fast-hierarchy-dump"
OUT_DIR="$SCRIPT_DIR/out"
CLASS_DIR="$BUILD_DIR/classes"
DEX_DIR="$BUILD_DIR/dex"
CLASS_JAR="$BUILD_DIR/classes.jar"
OUTPUT_JAR="$OUT_DIR/hezi-fast-hierarchy-dump.jar"

test -f "$SDK_PLATFORM/android.jar"
test -f "$SDK_PLATFORM/uiautomator.jar"
test -f "$SDK_PLATFORM/optional/android.test.runner.jar"
test -f "$SDK_PLATFORM/optional/android.test.base.jar"
test -x "$D8"
test -x "$JDK_BIN/javac"
test -x "$JDK_BIN/jar"

rm -rf "$BUILD_DIR"
mkdir -p "$CLASS_DIR" "$DEX_DIR" "$OUT_DIR"

"$JDK_BIN/javac" \
  -source 8 \
  -target 8 \
  -Xlint:all,-options \
  -classpath "$SDK_PLATFORM/android.jar:$SDK_PLATFORM/uiautomator.jar:$SDK_PLATFORM/optional/android.test.runner.jar:$SDK_PLATFORM/optional/android.test.base.jar" \
  -d "$CLASS_DIR" \
  "$SCRIPT_DIR/src/com/hezi/tools/FastHierarchyDump.java"

"$JDK_BIN/jar" cf "$CLASS_JAR" -C "$CLASS_DIR" .
JAVA_HOME="$JDK_HOME" "$D8" \
  --min-api 18 \
  --lib "$SDK_PLATFORM/android.jar" \
  --lib "$SDK_PLATFORM/uiautomator.jar" \
  --lib "$SDK_PLATFORM/optional/android.test.runner.jar" \
  --lib "$SDK_PLATFORM/optional/android.test.base.jar" \
  --output "$DEX_DIR" \
  "$CLASS_JAR"
rm -f "$OUTPUT_JAR"
"$JDK_BIN/jar" cf "$OUTPUT_JAR" -C "$DEX_DIR" classes.dex

"$JDK_BIN/jar" tf "$OUTPUT_JAR" | grep -qx 'classes.dex'
printf '%s\n' "$OUTPUT_JAR"
