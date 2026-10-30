package com.hezi.tools;

import android.graphics.Rect;
import android.os.Environment;
import android.util.Xml;
import android.view.accessibility.AccessibilityNodeInfo;
import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.core.UiDevice;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.xmlpull.v1.XmlSerializer;

/** Point-in-time hierarchy dump that tolerates null children in animated accessibility trees. */
public final class FastHierarchyDump extends UiAutomatorTestCase {
  private static final String DEFAULT_OUTPUT = "hezi-window.xml";
  private static final String OUTPUT_MARKER = "HEZI_UI_DUMP:";
  private static final int MAX_NODES = 10000;
  private static final int MAX_DEPTH = 100;
  private int nodeCount;

  public void testDump() throws Exception {
    File directory = new File(Environment.getDataDirectory(), "local/tmp");
    if (!directory.isDirectory() && !directory.mkdirs()) {
      throw new IllegalStateException("cannot create hierarchy directory: " + directory);
    }
    File output = new File(directory, outputName());
    if (output.exists() && !output.delete()) {
      throw new IllegalStateException("cannot remove old hierarchy: " + output);
    }
    Configurator.getInstance().setWaitForIdleTimeout(0L);
    AccessibilityNodeInfo root = currentRoot(getUiDevice());
    if (root == null) throw new IllegalStateException("active accessibility root is null");
    boolean complete = false;
    try {
      writeHierarchy(output, root);
      complete = true;
    } finally {
      root.recycle();
      if (!complete && output.exists() && !output.delete()) {
        System.err.println("cannot remove incomplete hierarchy: " + output);
      }
    }
    if (!output.isFile() || output.length() <= 0L) {
      if (output.exists()) output.delete();
      throw new IllegalStateException("hierarchy was not created: " + output);
    }
    System.out.println(OUTPUT_MARKER + output.getAbsolutePath());
  }

  private void writeHierarchy(File output, AccessibilityNodeInfo root) throws Exception {
    FileOutputStream stream = new FileOutputStream(output, false);
    boolean complete = false;
    try {
      XmlSerializer serializer = Xml.newSerializer();
      serializer.setOutput(stream, "UTF-8");
      serializer.startDocument("UTF-8", true);
      serializer.startTag(null, "hierarchy");
      serializer.attribute(null, "rotation", String.valueOf(getUiDevice().getDisplayRotation()));
      nodeCount = 0;
      writeNode(serializer, root, 0, 0);
      serializer.endTag(null, "hierarchy");
      serializer.endDocument();
      serializer.flush();
      stream.getFD().sync();
      complete = true;
    } finally {
      stream.close();
      if (!complete && output.exists()) output.delete();
    }
  }

  private void writeNode(
      XmlSerializer serializer, AccessibilityNodeInfo node, int index, int depth) throws Exception {
    if (depth > MAX_DEPTH) throw new IllegalStateException("hierarchy depth limit exceeded");
    nodeCount++;
    if (nodeCount > MAX_NODES) throw new IllegalStateException("hierarchy node limit exceeded");
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    serializer.startTag(null, "node");
    attribute(serializer, "index", String.valueOf(index));
    attribute(serializer, "text", chars(node.getText()));
    attribute(serializer, "resource-id", safe(node.getViewIdResourceName()));
    attribute(serializer, "class", chars(node.getClassName()));
    attribute(serializer, "package", chars(node.getPackageName()));
    attribute(serializer, "content-desc", chars(node.getContentDescription()));
    attribute(serializer, "checkable", String.valueOf(node.isCheckable()));
    attribute(serializer, "checked", String.valueOf(node.isChecked()));
    attribute(serializer, "clickable", String.valueOf(node.isClickable()));
    attribute(serializer, "enabled", String.valueOf(node.isEnabled()));
    attribute(serializer, "focusable", String.valueOf(node.isFocusable()));
    attribute(serializer, "focused", String.valueOf(node.isFocused()));
    attribute(serializer, "scrollable", String.valueOf(node.isScrollable()));
    attribute(serializer, "long-clickable", String.valueOf(node.isLongClickable()));
    attribute(serializer, "password", String.valueOf(node.isPassword()));
    attribute(serializer, "selected", String.valueOf(node.isSelected()));
    attribute(serializer, "visible-to-user", String.valueOf(node.isVisibleToUser()));
    attribute(
        serializer,
        "bounds",
        "[" + bounds.left + "," + bounds.top + "][" + bounds.right + "," + bounds.bottom + "]");
    int childCount = node.getChildCount();
    for (int childIndex = 0; childIndex < childCount; childIndex++) {
      AccessibilityNodeInfo child = node.getChild(childIndex);
      if (child == null) continue;
      try {
        // Match the legacy visible-tree contract; hidden underlying controls are not actionable.
        if (child.isVisibleToUser()) writeNode(serializer, child, childIndex, depth + 1);
      } finally {
        child.recycle();
      }
    }
    serializer.endTag(null, "node");
  }

  private static void attribute(XmlSerializer serializer, String name, String value)
      throws Exception {
    serializer.attribute(null, name, value);
  }

  private static String chars(CharSequence value) {
    return safe(value == null ? "" : value.toString());
  }

  private static String safe(String value) {
    if (value == null) return "";
    StringBuilder result = new StringBuilder(value.length());
    for (int offset = 0; offset < value.length(); ) {
      int codePoint = value.codePointAt(offset);
      offset += Character.charCount(codePoint);
      if (codePoint == 0x9
          || codePoint == 0xA
          || codePoint == 0xD
          || (codePoint >= 0x20 && codePoint <= 0xD7FF)
          || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
          || (codePoint >= 0x10000 && codePoint <= 0x10FFFF)) result.appendCodePoint(codePoint);
      else result.append('\uFFFD');
    }
    return result.toString();
  }

  /**
   * Use the exact bridge field and read-only root accessor observed on this device framework. No
   * new automation connection is created and no interaction, wait, or global method is invoked.
   */
  private static AccessibilityNodeInfo currentRoot(UiDevice device) throws Exception {
    Object bridge = null;
    for (Class<?> type = device.getClass(); type != null; type = type.getSuperclass()) {
      try {
        Field field = type.getDeclaredField("mUiAutomationBridge");
        if (!field.getType().getName().equals("com.android.uiautomator.core.UiAutomatorBridge")) {
          throw new IllegalStateException("mUiAutomationBridge declared type differs");
        }
        field.setAccessible(true);
        bridge = field.get(device);
        break;
      } catch (NoSuchFieldException ignored) {
        // Probe only the same exact field name on the superclass.
      }
    }
    if (bridge == null) throw new IllegalStateException("existing UiAutomatorBridge is unavailable");
    for (Class<?> type = bridge.getClass(); type != null; type = type.getSuperclass()) {
      try {
        Method method = type.getDeclaredMethod("getRootInActiveWindow");
        if (method.getParameterTypes().length != 0
            || method.getReturnType() != AccessibilityNodeInfo.class) {
          throw new IllegalStateException("getRootInActiveWindow signature differs");
        }
        method.setAccessible(true);
        Object root = method.invoke(bridge);
        if (root == null) throw new IllegalStateException("active accessibility root is null");
        if (!(root instanceof AccessibilityNodeInfo)) {
          throw new IllegalStateException("active accessibility root type differs");
        }
        return (AccessibilityNodeInfo) root;
      } catch (NoSuchMethodException ignored) {
        // Probe only the same exact zero-argument method on the superclass.
      }
    }
    throw new IllegalStateException("read-only bridge root accessor is unavailable");
  }

  private String outputName() {
    String value = getParams().getString("output");
    if (value == null || value.length() == 0) return DEFAULT_OUTPUT;
    if (!value.matches("[A-Za-z0-9._-]+") || value.equals(".") || value.equals("..")) {
      throw new IllegalArgumentException("output must be a simple file name");
    }
    return value;
  }
}
