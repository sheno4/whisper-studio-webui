import type { TaskRecord, ToastEvent } from '../../../shared/types';

/** Match the observable uploaded name across Windows/Linux server path rules. */
function uploadNames(name: string): string[] {
  const sanitize = (input: string): string => {
    const base = input.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    const lastDot = base.lastIndexOf('.');
    const extension = lastDot > 0 ? base.slice(lastDot) : '';
    return (base.length > 180 && extension.length < 180
      ? base.slice(0, 180 - extension.length) + extension : base.slice(0, 180)) || 'upload.bin';
  };
  return [...new Set([name, sanitize(name), sanitize(name.split(/[\\/]/).at(-1) || name)])];
}

export function matchesImportedFile(task: Pick<TaskRecord, 'input' | 'displayName'> | undefined, names: string[] | undefined): boolean {
  if (!names) return true;
  if (!task) return false;
  const path = task.input.replaceAll('\\', '/');
  return names.some((name) => uploadNames(name).some((candidate) => task.displayName === candidate || path.endsWith(`/${candidate}`) || path === candidate));
}

export function isImportError(toast: ToastEvent, source: 'link' | 'file'): boolean {
  return toast.tone === 'error' && (source === 'link' ? toast.title === '任务创建失败'
    : toast.title === '拖放导入失败' || toast.title === '文件导入失败');
}
