import { motion } from 'framer-motion';

import { APP_NAME } from '../../shared/constants';
import type { TranslationServiceData } from '../../shared/types';
import { fadeUpVariants } from '../motion';
import AnimatedSelect from './AnimatedSelect';
import Icon from './Icon';

interface AppHeaderProps {
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
  activeTaskCount,
  queueCount,
  historyCount,
  translationServices,
  activeTranslationServiceId,
  serviceBusy,
  onChangeService,
  onOpenSettings
}: AppHeaderProps): React.JSX.Element {
  const workspaceStatus = activeTaskCount > 0 ? `${activeTaskCount} 个任务处理中` : '工作台空闲';
  const enabledServices = translationServices.filter((service) => service.enabled);
  const translationServiceOptions = enabledServices.length > 0
    ? enabledServices.map((service) => ({
        value: service.id,
        label: service.name,
        description: service.model
      }))
    : [{ value: '', label: '未配置', description: '请在设置中添加翻译服务' }];

  return (
    <motion.header className="app-header glass-chrome" variants={fadeUpVariants}>
      <div className="brand-group">
        <div className="brand-mark" aria-hidden="true">
          <Icon name="waveform" size={21} />
        </div>
        <div className="brand-copy">
          <h1>{APP_NAME}</h1>
          <p>Local media intelligence</p>
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
    </motion.header>
  );
}

export default AppHeader;
