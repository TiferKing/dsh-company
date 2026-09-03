import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot } from '../types.js'
import { InfoIcon, PackageIcon } from '../icons.js'
import { completedWorkCount, formatMoneyMicros, percent, productStatusLabel, productTone, StatusBadge } from '../ui.js'

export interface ProductsViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
}

export function ProductsView({ snapshot, t, locale }: ProductsViewProps): React.JSX.Element {
  return (
    <div className="dsh-company-view">
      <header>
        <h2 className="dsh-company-view__heading">{t('tab.products')}</h2>
      </header>
      {snapshot.products.length === 0 ? (
        <p className="dsh-company-empty dsh-company-section"><PackageIcon />{t('products.none')}</p>
      ) : (
        <div className="dsh-company-products">
          {snapshot.products.map((product) => {
            const work = snapshot.work.filter((item) => item.product_id === product.id)
            const done = completedWorkCount(work.map((item) => item.status))
            const progress = percent(done, work.length)
            const moneyProgress = percent((product.spent_micros ?? 0) + (product.reserved_micros ?? 0), product.budget_micros ?? 0)
            return (
              <article className="dsh-company-card" key={product.id}>
                <div className="dsh-company-card__title-row">
                  <div>
                    <h3 className="dsh-company-card__title">{product.name}</h3>
                    <p className="dsh-company-card__copy">{product.summary}</p>
                  </div>
                  <StatusBadge tone={productTone(product.status)}>
                    {productStatusLabel(product.status, t)}
                  </StatusBadge>
                </div>

                <div className="dsh-company-product__root">
                  <strong>{t('products.root')}:</strong> {product.product_root}
                </div>

                <section className="dsh-company-section">
                  <h4 className="dsh-company-section__title">{t('products.criteria')}</h4>
                  {product.success_criteria.length === 0 ? (
                    <p className="dsh-company-card__copy">{t('products.noCriteria')}</p>
                  ) : (
                    <ul className="dsh-company-criteria">
                      {product.success_criteria.map((criterion, index) => (
                        <li key={`${index}-${criterion}`}>{criterion}</li>
                      ))}
                    </ul>
                  )}
                </section>

                <div className="dsh-company-progress-row">
                  <div className="dsh-company-progress-row__labels">
                    <span>{t('products.work')}</span>
                    <span>{t('products.progress', { done, total: work.length })}</span>
                  </div>
                  <progress
                    className="dsh-company-progress"
                    data-tone={progress === 100 ? 'success' : undefined}
                    max={100}
                    value={progress}
                  />
                </div>

                <div className="dsh-company-progress-row">
                  <div className="dsh-company-progress-row__labels"><span>{t('products.moneyBudget')}</span><span>{moneyProgress}%</span></div>
                  <progress className="dsh-company-progress" max={100} value={moneyProgress} />
                </div>

                <footer className="dsh-company-product__footer">
                  <span>{product.id}</span>
                  <span>{t('products.moneyBudget')}: {formatMoneyMicros(product.budget_micros, snapshot.budget.currency, locale)} · {t('products.moneySpent')}: {formatMoneyMicros(product.spent_micros, snapshot.budget.currency, locale)} · {t('products.moneyAvailable')}: {formatMoneyMicros(product.available_micros, snapshot.budget.currency, locale)}</span>
                  <span>{t('products.tokenAnalytics')}: {product.token_used.toLocaleString(locale)} / {product.token_budget.toLocaleString(locale)} tokens</span>
                </footer>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
