<?php
/** @var array $_ */
declare(strict_types=1);
?>
<div id="presentationconverter" class="pconv"
     data-ready="<?php p($_['ready'] ? 'yes' : 'no'); ?>"
     data-keynote="<?php p($_['keynoteSupported'] ? 'yes' : 'no'); ?>">

    <div class="pconv-header">
        <h2><?php p($l->t('Presentation Converter')); ?></h2>
        <p class="pconv-lede">
            <?php p($l->t('Keeps a PDF and a presenter-notes sidecar beside every presentation in the folders you choose, including all subfolders.')); ?>
        </p>
    </div>

    <?php if (!$_['ready']): ?>
        <div class="pconv-banner pconv-banner--warning">
            <?php p($l->t('No converter is configured yet. An administrator needs to set this up in Settings → Administration → Presentation Converter.')); ?>
        </div>
    <?php else: ?>
        <p class="pconv-formats">
            <?php p($l->t('Convertible here:')); ?>
            <strong><?php p(implode(', ', array_map(static fn ($f) => '.' . $f, $_['formats']))); ?></strong>
            <?php if (!$_['keynoteSupported']): ?>
                <span class="pconv-muted">
                    — <?php p($l->t('Keynote files need a paired macOS worker, which is not configured.')); ?>
                </span>
            <?php endif; ?>
        </p>
    <?php endif; ?>

    <form class="pconv-add" id="pconv-add-form">
        <label for="pconv-path"><?php p($l->t('Folder to keep converted')); ?></label>
        <div class="pconv-row">
            <input type="text" id="pconv-path" name="path" placeholder="/Presentations" autocomplete="off" />
            <button type="submit" class="primary"><?php p($l->t('Add folder')); ?></button>
        </div>
        <p class="pconv-hint">
            <?php p($l->t('Path relative to your files, for example /Events/2026. Subfolders are included.')); ?>
        </p>
    </form>

    <div id="pconv-message" class="pconv-banner" hidden></div>

    <h3><?php p($l->t('Folders')); ?></h3>
    <table class="pconv-table">
        <thead>
            <tr>
                <th><?php p($l->t('Folder')); ?></th>
                <th><?php p($l->t('Last run')); ?></th>
                <th><?php p($l->t('Result')); ?></th>
                <th></th>
            </tr>
        </thead>
        <tbody id="pconv-folders">
            <tr class="pconv-empty"><td colspan="4"><?php p($l->t('Loading…')); ?></td></tr>
        </tbody>
    </table>
</div>
