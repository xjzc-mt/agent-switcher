/* Existing POSIX profiles may predate the portable naming rules. */
function profileNameError(name, portable = true) {
  if (typeof name !== 'string' || !name || name.trim() !== name || name.length > 100 ||
      name === '.' || name.includes('..') || /[\\/\x00-\x1f\x7f]/.test(name)) {
    return '账号名称须为 1–100 个字符，不能含首尾空白、路径分隔符、连续点或控制字符';
  }
  if (!portable) return '';
  if (/[<>:"|?*]/.test(name) || name.endsWith('.')) return '账号名称不能包含 < > : " | ? * 或以点结尾';
  const stem = name.split('.')[0].trimEnd();
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/i.test(stem)) {
    return '账号名称使用了 Windows 保留名，请换一个名称';
  }
  return '';
}
if (typeof module !== 'undefined') module.exports = profileNameError;
