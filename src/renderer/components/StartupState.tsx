import { APP_NAME } from '../../shared/constants';
import Icon from './Icon';

interface StartupStateProps {
  error?: string;
  onRetry: () => void;
}

function StartupState({ error, onRetry }: StartupStateProps): React.JSX.Element {
  return (
    <section className="startup-state">
      <div className={`startup-card glass-float ${error ? 'error' : ''}`}>
        <div className="startup-symbol">
          {error ? <Icon name="warning" size={24} /> : <Icon name="waveform" size={24} />}
        </div>
        <div>
          <p className="eyebrow">{error ? '启动异常' : '正在准备'}</p>
          <h1>{error ? `${APP_NAME} 无法启动` : `正在启动 ${APP_NAME}`}</h1>
          <p>{error || '正在加载配置、环境状态与任务队列。'}</p>
        </div>
        {error ? (
          <button className="primary-button" onClick={onRetry} type="button">
            <Icon name="retry" size={16} /> 重试
          </button>
        ) : <span className="startup-loader" />}
      </div>
    </section>
  );
}

export default StartupState;
