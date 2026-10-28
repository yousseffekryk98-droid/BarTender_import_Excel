// Pure text-editing helpers shared by the editor and tests.
export function suggestedFixedText(object, previewText) {
  // Resolve the visible text before freezing a dynamic Excel/automatic binding.
  // Prefix, suffix and source-specific formatting are removed on conversion.
  return String(previewText ?? '');
}

export function buildTextEditPatch(object, updatedContent, convertedToFixed) {
  const content = { ...object.content, ...updatedContent };
  if (convertedToFixed && content.mode === 'static' && object.content.mode !== 'static') {
    return { content, prefix: '', suffix: '', format: { kind: 'none' } };
  }
  return { content };
}
