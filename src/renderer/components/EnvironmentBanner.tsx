import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

import type { EnvironmentStatus } from '../../shared/types';
import { fadeUpVariants } from '../motion';
import { formatDateTime, normalizeUiText } from '../utils';
import Icon from './Icon';

interface EnvironmentBannerProps {
  environment: EnvironmentStatus;
}

const detailsId = 'environment-details-popover';

const EnvironmentBanner = ({ environment }: EnvironmentBannerProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const failedItems = environment.items.filter((item) => !item.ok);
  const totalItems = environment.items.length;
  const readyItems = totalItems - failedItems.length;
  const isReady = totalItems > 0 && failedItems.length === 0;
  const hasNoChecks = totalItems === 0;

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded]);

  const title = hasNoChecks
    ? '环境状态待检查'
    : isReady
      ? '运行环境已就绪'
      : `发现 ${failedItems.length} 项环境问题`;
  const description = hasNoChecks
    ? '暂时没有可用的环境检查结果。'
    : isReady
      ? '核心依赖均可正常使用。'
      : '部分功能可能受限，请查看详情与修复建议。';
  const tone = hasNoChecks ? 'neutral' : isReady ? 'ready' : 'warning';

  return (
    <section
      aria-label="运行环境状态"
      className={`environment-bar environment-bar--${tone}`}
      ref={shellRef}
    >
      <div aria-live="polite" className="environment-bar__summary" role="status">
        <span aria-hidden="true" className="environment-bar__status-icon">
          <Icon name={hasNoChecks ? 'info' : isReady ? 'check' : 'warning'} size={17} />
        </span>
        <span className="environment-bar__copy">
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <span
          aria-label={`${readyItems} 项可用，共 ${totalItems} 项检查`}
          className="environment-bar__count"
          title={`最近检查：${formatDateTime(environment.checkedAt)}`}
        >
          {readyItems}/{totalItems}
          <small> 可用</small>
        </span>
      </div>

      <button
        aria-controls={detailsId}
        aria-expanded={expanded}
        aria-haspopup="true"
        className="environment-bar__toggle"
        onClick={() => setExpanded((current) => !current)}
        title={expanded ? '收起环境检查详情' : '查看环境检查详情'}
        type="button"
      >
        <span>{expanded ? '收起' : '详情'}</span>
        <Icon
          aria-hidden="true"
          className={`environment-bar__toggle-icon${expanded ? ' is-expanded' : ''}`}
          name="chevron-down"
          size={15}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            animate="visible"
            aria-labelledby="environment-details-title"
            className="environment-popover liquid-glass-panel"
            exit="exit"
            id={detailsId}
            initial="hidden"
            role="region"
            variants={fadeUpVariants}
          >
            <span aria-hidden="true" className="environment-popover__glow liquid-glass-glow" />
            <header className="environment-popover__header">
              <div>
                <p className="section-eyebrow">系统诊断</p>
                <h3 id="environment-details-title">运行环境</h3>
                <small>检查于 {formatDateTime(environment.checkedAt)}</small>
              </div>
              <button
                aria-label="关闭环境详情"
                className="environment-popover__close"
                onClick={() => setExpanded(false)}
                title="关闭环境详情"
                type="button"
              >
                <Icon aria-hidden="true" name="close" size={17} />
              </button>
            </header>

            {hasNoChecks ? (
              <div className="environment-popover__empty">
                <Icon aria-hidden="true" name="info" size={18} />
                <p>应用尚未返回环境检查项目，请稍后重新打开此面板。</p>
              </div>
            ) : (
              <div aria-label="环境检查项目" className="environment-popover__list" role="list">
                {environment.items.map((item) => {
                  const details = normalizeUiText(item.details) || '没有更多说明';
                  const suggestion = normalizeUiText(item.suggestion);

                  return (
                    <article
                      aria-label={`${item.label}：${item.ok ? '可用' : '需要处理'}`}
                      className={`environment-check environment-check--${item.ok ? 'ready' : 'warning'}`}
                      key={item.key}
                      role="listitem"
                    >
                      <span aria-hidden="true" className="environment-check__icon">
                        <Icon name={item.ok ? 'check' : 'warning'} size={16} />
                      </span>
                      <div className="environment-check__content">
                        <header>
                          <strong>{item.label}</strong>
                          <span className="environment-check__state">
                            {item.ok ? '可用' : '需处理'}
                          </span>
                        </header>
                        <p title={details}>{details}</p>
                        {suggestion ? (
                          <div className="environment-check__suggestion">
                            <Icon aria-hidden="true" name="info" size={14} />
                            <span>
                              <strong>建议</strong>
                              {suggestion}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
};

export default EnvironmentBanner;
