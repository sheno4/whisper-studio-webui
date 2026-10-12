import { APP_NAME } from '../../shared/constants';
import type { TranslationServiceData } from '../../shared/types';
import type { Appearance, Material } from '../hooks/useAppearance';
import AnimatedSelect from './AnimatedSelect';
import Icon from './Icon';

interface AppHeaderProps {
  appearance: Appearance;
  material: Material;
  onCycleAppearance: () => void;
  onToggleMaterial: () => void;
  activeTaskCount: number;
  queueCount: number;
  historyCount: number;
  translationServices: TranslationServiceData[];
  activeTranslationServiceId?: string;
  serviceBusy: boolean;
  onChangeService: (serviceId: string) => void;
  onOpenSettings: () => void;
}

function AppHeader({
  appearance,
  material,
  onCycleAppearance,
  onToggleMaterial,
  activeTaskCount,
  queueCount,
  historyCount,
  translationServices,
  activeTranslationServiceId,
  serviceBusy,
  onChangeService,
  onOpenSettings
}: AppHeaderProps): React.JSX.Element {
  const workspaceStatus = activeTaskCount > 0 ? `${activeTaskCount} 个任务进行中` : '当前空闲';
  const appearanceLabel = { system: '跟随系统', light: '浅色', dark: '深色' }[appearance];
  const enabledServices = translationServices.filter((service) => service.enabled);
  const translationServiceOptions = enabledServices.length > 0
    ? enabledServices.map((service) => ({
        value: service.id,
        label: service.name,
        description: service.model
      }))
    : [{ value: '', label: '未配置', description: '请在设置中添加翻译服务' }];

  return (
    <header className="app-header glass-chrome">
      <div className="brand-group">
        <div className="brand-mark" aria-hidden="true">
          <Icon name="waveform" size={21} />
        </div>
        <div className="brand-copy">
          <h1>{APP_NAME}</h1>
          <p>音视频工作台</p>
        </div>
      </div>

      <div className="workspace-pulse" aria-label="工作台状态">
        <span className={`pulse-dot ${activeTaskCount > 0 ? 'active' : ''}`} />
        <span>{workspaceStatus}</span>
      </div>

      <div className="header-metrics" aria-label="任务概览">
        <span><Icon name="queue" size={14} /> 队列 {queueCount}</span>
        <span><Icon name="history" size={14} /> 历史 {historyCount}</span>
      </div>

      <div className="header-actions">
        <div className="appearance-controls" aria-label="界面外观">
          <button
            aria-label={`外观：${appearanceLabel}，点击切换`}
            className="icon-button appearance-button"
            onClick={onCycleAppearance}
            title={`外观：${appearanceLabel}（点击切换浅色、深色或跟随系统）`}
            type="button"
          >
            <Icon name="palette" size={18} />
            <span>{appearanceLabel}</span>
          </button>
          <button
            aria-label="减少透明效果"
            aria-pressed={material === 'solid'}
            className="icon-button material-button"
            onClick={onToggleMaterial}
            title={material === 'solid' ? '使用玻璃材质' : '减少透明效果'}
            type="button"
          >
            <Icon name="model" size={18} />
          </button>
        </div>
        <AnimatedSelect
          buttonClassName="header-provider-trigger"
          className="header-provider"
          disabled={serviceBusy || enabledServices.length === 0}
          id="header-translation-provider"
          label="翻译服务"
          minWidth={208}
          onChange={onChangeService}
          options={translationServiceOptions}
          value={activeTranslationServiceId || ''}
        />
        <button aria-label="打开设置" className="icon-button settings-button" onClick={onOpenSettings} type="button">
          <Icon name="settings" size={18} />
        </button>
      </div>
    </header>
  );
}

export default AppHeader;
